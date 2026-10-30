import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Store } from "../src/store.mjs";
import { createService } from "../src/server.mjs";
import { nextDue } from "../src/contracts.mjs";
const script = {
  type: "script",
  command: process.execPath,
  args: ["-e", "process.stdin.on('data',d=>console.log(JSON.parse(d).data.text))"],
  cwd: tmpdir(),
  timeout_seconds: 3,
};
const cfg = (source = { type: "webhook" }) => ({
  name: "test",
  enabled: true,
  source,
  action: script,
});
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    const x = await fn();
    if (x) return x;
    await sleep(100);
  }
  throw Error("Condition timed out");
}
test("queues coalesce changes, skip overlapping schedules, retain webhooks and recover interrupted work", () => {
  const d = mkdtempSync(join(tmpdir(), "woc-trigger-"));
  let s;
  try {
    s = new Store(join(d, "db"), { woc: {} });
    const t = s.save(cfg({ type: "mcp", connection: "woc", uri: "wechat://test/messages" }));
    const first = s.enqueue(t.id, {}, "mcp");
    assert(s.enqueue(t.id, {}, "mcp").coalesced);
    s.patch(first.run_id, "running");
    s.enqueue(t.id, {}, "mcp");
    assert(s.enqueue(t.id, {}, "timer").skipped);
    assert(s.enqueue(t.id, {}, "mcp").coalesced);
    s.close();
    s = new Store(join(d, "db"), { woc: {} });
    assert.equal(s.run(first.run_id).status, "interrupted");
    assert.equal(s.runs().filter((r) => r.status === "queued").length, 1);
    const hook = s.save(cfg());
    assert(s.checkHook(hook.id, hook.webhook_secret));
    assert(!s.checkHook(hook.id, "wrong"));
    for (let i = 0; i < 32; i++) s.enqueue(hook.id, { i }, "webhook");
    assert.throws(() => s.enqueue(hook.id, {}, "webhook"), /limit/);
    s.save({ ...hook, enabled: false }, hook.id);
    assert(!s.checkHook(hook.id, hook.webhook_secret));
    assert.equal(s.get(hook.id).next_run, null);
    assert.equal(s.runs(hook.id).filter((r) => r.status === "queued").length, 0);
  } finally {
    s?.close();
    rmSync(d, { recursive: true, force: true });
  }
});
test("cron uses timezone and strict configuration validation", () => {
  const now = Date.parse("2026-10-30T00:00:00Z");
  assert.equal(
    nextDue({ type: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" }, now),
    Date.parse("2026-10-30T01:00:00Z"),
  );
  const s = new Store(":memory:");
  try {
    assert.throws(() => s.save(cfg({ type: "cron", expression: "invalid", timezone: "bad" })));
    assert.throws(() => s.save(cfg({ type: "interval", seconds: 0 })));
  } finally {
    s.close();
  }
});
test("authenticated HTTP, hostile input stays data, timeouts, logs and webhook lifecycle", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "woc-trigger-http-"));
  const service = createService({ stateDir, port: 0, connections: {} });
  const port = await service.start();
  const token = readFileSync(join(stateDir, "admin.token"), "utf8");
  const call = async (path, method = "GET", data, key = token) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: r.status, body: await r.json() };
  };
  try {
    assert.equal((await call("/triggers", "GET", undefined, "wrong")).status, 401);
    const t = (await call("/triggers", "POST", cfg())).body;
    const value = '$(touch /tmp/should-not-exist)\n"; echo nope';
    const receipt = await call(`/hooks/${t.id}`, "POST", { text: value }, t.webhook_secret);
    assert.equal(receipt.status, 202);
    const r = await until(() => {
      const r = service.store.run(receipt.body.run_id);
      return r.status === "succeeded" && r;
    });
    assert.equal(r.log.trim(), value);
    assert.equal((await call(`/hooks/${t.id}`, "POST", {}, token)).status, 401);
    const slow = service.store.save({
      ...cfg(),
      action: {
        ...script,
        args: [
          "-e",
          "const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});writeFileSync(process.env.WOC_TRIGGER_STATE_DIR+'/child.pid',String(child.pid));setInterval(()=>{},1000)",
        ],
        timeout_seconds: 1,
      },
    });
    const run = service.store.enqueue(slow.id);
    await until(() => service.store.run(run.run_id).status === "failed");
    assert.match(service.store.run(run.run_id).log, /timed out/);
    const childPid = Number(readFileSync(join(stateDir, "scripts", slow.id, "child.pid"), "utf8"));
    await until(() => {
      try {
        process.kill(childPid, 0);
        return false;
      } catch {
        return true;
      }
    });
    const bad = await call("/triggers", "POST", {
      ...cfg(),
      source: { type: "mcp", connection: "unknown", uri: "x" },
    });
    assert.equal(bad.status, 400);
  } finally {
    await service.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
test("agent calls serialize per target and record dispatch separately", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "woc-trigger-agent-"));
  let calls = 0;
  const paseo = {
    agents: async () => [],
    execute: async (a, event, signal, dispatch) => {
      calls++;
      dispatch({ delivery: "accepted", agent_id: a.agent_id });
      await sleep(200, undefined, { signal });
      return { completion: "idle_observed", delivery: "accepted" };
    },
  };
  const service = createService({ stateDir, port: 0, connections: {} }, { paseo });
  await service.start();
  try {
    const action = {
      type: "agent",
      agent_id: "example",
      message: "test",
      include_input: false,
      timeout_seconds: 3,
    };
    const a = service.store.enqueueAgent(action, "same");
    const b = service.store.enqueueAgent(action, "same");
    assert.equal(a.run_id, b.run_id);
    await until(() => service.store.run(a.run_id).status === "succeeded");
    assert.equal(calls, 1);
    assert.equal(service.store.run(a.run_id).result.delivery, "accepted");
  } finally {
    await service.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
