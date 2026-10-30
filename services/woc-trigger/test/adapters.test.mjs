import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createService } from "../src/server.mjs";
import { Paseo } from "../src/paseo.mjs";
async function until(fn) {
  for (let i = 0; i < 120; i++) {
    if (await fn()) return;
    await sleep(100);
  }
  throw Error("Timed out");
}
test("real stdio MCP subscribe, burst coalescing, reconnect and pause", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "woc-mcp-")),
    service = createService({
      stateDir,
      connections: {
        test: {
          command: process.execPath,
          args: [new URL("./fixtures/mcp.mjs", import.meta.url).pathname],
        },
      },
      port: 0,
    });
  await service.start();
  try {
    const t = service.store.save({
      name: "MCP",
      enabled: true,
      source: { type: "mcp", connection: "test", uri: "fixture://messages" },
      action: {
        type: "script",
        command: process.execPath,
        args: ["-e", "setTimeout(()=>{},1200)"],
        cwd: tmpdir(),
        timeout_seconds: 3,
      },
    });
    await until(() => service.store.runs(t.id).filter((r) => r.status === "succeeded").length >= 3);
    assert(service.store.runs(t.id).length < 10, "burst notifications should coalesce");
    await until(
      () => !service.store.runs(t.id).some((r) => ["running", "waiting"].includes(r.status)),
    );
    service.store.save({ ...t, enabled: false }, t.id);
    await until(() => service.engine.sources.size === 0);
  } finally {
    await service.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
test("Paseo requires matched response evidence; busy waits and abort preserves unknown delivery", async () => {
  let snapshots = 0,
    sent = 0,
    closed = 0,
    timelines = 0;
  const receipts = [];
  const c = {
    connect: async () => {},
    close: async () => {
      closed++;
    },
    fetchAgent: async () => ({ agent: { status: ++snapshots === 1 ? "running" : "idle" } }),
    sendMessage: async () => {
      sent++;
    },
    fetchAgentTimeline: async () => ({
      entries:
        ++timelines === 1
          ? []
          : [
              { item: { type: "user_message", clientMessageId: "run" } },
              { item: { type: "assistant_message", text: "done" } },
            ],
    }),
  };
  const p = new Paseo(async () => c);
  const result = await p.execute(
    { agent_id: "a", message: "test", include_input: true },
    { run_id: "run" },
    AbortSignal.timeout(5000),
    (r) => receipts.push(r),
  );
  assert.equal(sent, 1);
  assert.equal(closed, 1);
  assert.equal(receipts[0].delivery, "attempted");
  assert.equal(receipts[1].delivery, "accepted");
  assert.equal(result.completion, "reply_and_idle_observed");
  assert.equal(timelines, 2);
  const pending = new Paseo(async () => ({
    ...c,
    fetchAgentTimeline: async () => ({ entries: [] }),
  }));
  const uncertain = [];
  await assert.rejects(
    pending.execute(
      { agent_id: "a", message: "x" },
      { run_id: "other" },
      AbortSignal.timeout(200),
      (r) => uncertain.push(r),
    ),
  );
  assert(uncertain.some((r) => r.delivery === "accepted"));
  assert.equal(pending.busy.size, 0);
});
