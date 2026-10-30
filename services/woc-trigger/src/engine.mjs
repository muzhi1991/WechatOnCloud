import { mkdirSync, readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { nextDue } from "./contracts.mjs";
import { Paseo } from "./paseo.mjs";
function directoryBytes(path, limit) {
  let total = 0;
  for (const item of readdirSync(path, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const p = join(path, item.name);
    total += item.isDirectory() ? directoryBytes(p, limit - total) : statSync(p).size;
    if (total > limit) break;
  }
  return total;
}
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
    const timeout = setTimeout(
      () => controller.abort(Error("Action timed out")),
      run.action.timeout_seconds * 1000,
    );
    let accepted = null,
      log = "";
    this.store.patch(run.id, run.action.type === "agent" ? "waiting" : "running");
    try {
      let result;
      if (run.action.type === "agent")
        result = await this.paseo.execute(run.action, run.event, controller.signal, (r) => {
          accepted = r;
          this.store.patch(run.id, "running", { result: r });
        });
      else {
        const state = join(this.config.stateDir, "scripts", run.trigger_id || "manual");
        mkdirSync(state, { recursive: true, mode: 0o700 });
        if (directoryBytes(state, 16 * 1024 * 1024) > 16 * 1024 * 1024)
          throw Error("Script state exceeds 16 MiB; clean its state directory");
        result = await new Promise((resolve, reject) => {
          const child = spawn(run.action.command, run.action.args, {
            cwd: run.action.cwd,
            detached: true,
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              LANG: "C.UTF-8",
              TZ: process.env.TZ || "Asia/Shanghai",
              WOC_TRIGGER_URL: `http://127.0.0.1:${this.config.port}`,
              WOC_TRIGGER_TOKEN_FILE: this.config.tokenFile,
              WOC_TRIGGER_STATE_DIR: state,
              WOC_CLIENT_CONFIG: this.config.wocClientConfig || "",
              WOC_TRIGGER_CLI: new URL("./cli.mjs", import.meta.url).pathname,
            },
            stdio: ["pipe", "pipe", "pipe"],
          });
          const append = (d) => {
            log = (log + d.toString()).slice(-65536);
          };
          child.stdout.on("data", append);
          child.stderr.on("data", append);
          child.stdin.on("error", () => {});
          let killTimer;
          const kill = () => {
            if (!child.pid) return;
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch {}
            killTimer = setTimeout(() => {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {}
            }, 1000);
            killTimer.unref();
          };
          const quota = setInterval(() => {
            try {
              if (directoryBytes(state, 16 * 1024 * 1024) > 16 * 1024 * 1024)
                controller.abort(Error("Script state exceeds 16 MiB"));
            } catch (e) {
              controller.abort(e);
            }
          }, 1000);
          controller.signal.addEventListener("abort", kill, { once: true });
          if (controller.signal.aborted) kill();
          child.on("error", reject);
          child.on("close", (code, signal) => {
            clearInterval(quota);
            clearTimeout(killTimer);
            // A script action owns its process group; do not leave detached children behind.
            if (child.pid)
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {}
            controller.signal.removeEventListener("abort", kill);
            if (controller.signal.aborted) reject(controller.signal.reason);
            else if (code !== 0) reject(Error(`Script exited ${code ?? signal}`));
            else resolve({ exit_code: code });
          });
          child.stdin.end(JSON.stringify(run.event));
        });
      }
      this.store.patch(run.id, "succeeded", { log, result });
    } catch (e) {
      this.store.patch(run.id, accepted ? "unknown" : this.closed ? "interrupted" : "failed", {
        log: log + "\n" + e.message,
        result: accepted,
      });
    } finally {
      clearTimeout(timeout);
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
