import { readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { nextDue } from "./contracts.mjs";
import { Paseo } from "./paseo.mjs";
import { runScript } from "./runner.mjs";
import { commandFor } from "./scripts.mjs";
import { contextFor, resolve, stringify, output, tailText } from "./values.mjs";
export class Engine {
  constructor(store, config, { paseo = new Paseo() } = {}) {
    this.store = store;
    this.config = config;
    this.paseo = paseo;
    this.active = new Map();
    this.sources = new Map();
    this.closed = false;
    this.ticking = false;
  }
  start() {
    const tick = () =>
      void this.tick().catch((e) => {
        this.error = e.message;
      });
    this.timer = setInterval(tick, 500);
    tick();
  }
  async syncSources() {
    const desired = new Map();
    for (const t of this.store.list())
      if (t.enabled && t.source.type === "mcp") {
        const key = JSON.stringify([t.source.connection, t.source.uri]);
        const list = desired.get(key) || [];
        list.push(t.id);
        desired.set(key, list);
      }
    for (const [key, v] of this.sources)
      if (!desired.has(key)) {
        this.sources.delete(key);
        await v.client?.close().catch(() => {});
      }
    for (const [key, ids] of desired) {
      const existing = this.sources.get(key);
      if (existing) {
        existing.ids = ids;
        if (existing.client || existing.connecting || Date.now() < existing.retry) continue;
      }
      const entry = existing || { ids, retry: 0 };
      this.sources.set(key, entry);
      entry.connecting = true;
      void this.connectSource(key, entry);
    }
  }
  async connectSource(key, entry) {
    const [connection, uri] = JSON.parse(key),
      cfg = this.config.connections[connection];
    const client = new Client({ name: "woc-trigger", version: "0.1.0" });
    entry.client = client;
    const trigger = (reason) => {
      if (this.sources.get(key) !== entry || this.closed) return;
      for (const id of entry.ids)
        try {
          this.store.enqueue(id, { uri, connection, reason }, "mcp");
        } catch (e) {
          entry.error = e.message;
        }
    };
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      if (n.params.uri === uri) trigger("resource_updated");
    });
    client.onclose = () => {
      if (this.sources.get(key) === entry) {
        entry.client = null;
        entry.retry = Date.now() + 5000;
        entry.error = "Disconnected; reconnecting";
      }
    };
    try {
      await client.connect(
        new StdioClientTransport({
          command: cfg.command,
          args: cfg.args || [],
          env: { ...process.env, ...cfg.env },
          stderr: "ignore",
        }),
      );
      await client.subscribeResource({ uri });
      if (this.sources.get(key) !== entry || this.closed) {
        await client.close();
        return;
      }
      entry.error = null;
      trigger("connected");
    } catch (e) {
      entry.error = e.message;
      await client.close().catch(() => {});
      entry.client = null;
      entry.retry = Date.now() + 5000;
    } finally {
      entry.connecting = false;
    }
  }
  async tick() {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      await this.syncSources();
      const now = Date.now();
      for (const t of this.store.list())
        if (t.enabled && t.next_run !== null && t.next_run <= now) {
          try {
            this.store.enqueue(t.id, { scheduled_at: new Date(t.next_run).toISOString() }, "timer");
          } catch {}
          this.store.db
            .prepare("UPDATE triggers SET due=? WHERE id=?")
            .run(nextDue(t.source, now), t.id);
        }
      const queued = this.store.db
        .prepare("SELECT id,trigger_id FROM runs WHERE status='queued' ORDER BY created LIMIT 256")
        .all();
      for (const r of queued) {
        if (this.active.size >= 4) break;
        if ([...this.active.values()].some((x) => r.trigger_id && x.trigger === r.trigger_id))
          continue;
        const controller = new AbortController();
        const run = this.store.run(r.id);
        const active = { controller, trigger: r.trigger_id, promise: null };
        this.active.set(r.id, active);
        active.promise = this.execute(run, controller).finally(() => this.active.delete(r.id));
      }
      if (!this.swept || now - this.swept > 60000) {
        this.store.sweep();
        const root = join(this.config.stateDir, "scripts");
        if (existsSync(root))
          for (const item of readdirSync(root, { withFileTypes: true }))
            if (item.isDirectory() && !this.store.get(item.name))
              rmSync(join(root, item.name), { recursive: true, force: true });
        this.swept = now;
      }
    } finally {
      this.ticking = false;
    }
  }
  async execute(run, controller) {
    const pipeline = run.action.type === "pipeline";
    const actions = pipeline ? run.action.steps : [{ ...run.action, id: "action" }];
    let log = "",
      input = JSON.stringify(run.event),
      receipt = null,
      current;
    const outputs = {},
      results = [];
    const persist = (status = "running") =>
      this.store.patch(run.id, status, { log, result: { ...(receipt || {}), steps: results } });
    persist();
    try {
      for (const step of actions) {
        controller.signal.throwIfAborted();
        current = {
          id: step.id,
          type: step.type,
          status: "running",
          started: new Date().toISOString(),
        };
        results.push(current);
        if (step.skip_empty && !input.trim()) {
          current.status = "skipped";
          outputs[step.id] = output("");
          persist();
          continue;
        }
        const context = contextFor(run, outputs, input);
        const timeout = setTimeout(
          () => controller.abort(Error(`Step ${step.id} timed out`)),
          step.timeout_seconds * 1000,
        );
        try {
          persist();
          if (step.type === "agent") {
            const a = {
              ...step,
              agent_id: stringify(resolve(step.agent_id, context)),
              message: stringify(resolve(step.message, context)),
            };
            if (Buffer.byteLength(a.message) > 32768) throw Error("Agent message exceeds 32 KiB");
            const event = pipeline
              ? { ...run.event, run_id: run.id + ":" + step.id, data: context.input.json ?? input }
              : run.event;
            const result = await this.paseo.execute(a, event, controller.signal, (r) => {
              receipt = r;
              Object.assign(current, r);
              persist();
            });
            const { text: reply, ...receiptResult } = result;
            Object.assign(current, receiptResult);
            input = reply ?? JSON.stringify(receiptResult);
          } else {
            const a = commandFor(this.config, step, context);
            const result = await runScript(
              this.config,
              a,
              run,
              step.id,
              input,
              context,
              controller.signal,
              (d) => {
                log = tailText(log + d);
              },
            );
            input = result.text;
            current.stderr = result.stderr;
            current.exit_code = result.exit_code;
            // Legacy logs retain stdout; pipeline output is a distinct, bounded result.
            if (!pipeline) log = tailText(log + input);
          }
          if (Buffer.byteLength(input) > 262144) throw Error("Step output exceeds 256 KiB");
          outputs[step.id] = output(input);
          if (Buffer.byteLength(JSON.stringify(outputs)) > 524288)
            throw Error("Combined step outputs exceed 512 KiB");
          current.output = outputs[step.id];
          current.status = "succeeded";
          current.ended = new Date().toISOString();
          persist();
        } finally {
          clearTimeout(timeout);
        }
      }
      persist("succeeded");
    } catch (e) {
      if (current) {
        current.status = receipt ? "unknown" : "failed";
        current.error = e.message;
        current.ended = new Date().toISOString();
      }
      log = tailText(log + "\n" + e.message);
      persist(receipt ? "unknown" : this.closed ? "interrupted" : "failed");
    }
  }
  status() {
    return [...this.sources].map(([key, e]) => ({
      source: JSON.parse(key),
      connected: !!e.client && !e.connecting && !e.error,
      error: e.error || null,
    }));
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const e of this.active.values()) e.controller.abort(Error("Daemon stopping"));
    await Promise.allSettled([...this.sources.values()].map((s) => s.client?.close()));
    await Promise.allSettled([...this.active.values()].map((s) => s.promise));
  }
}
