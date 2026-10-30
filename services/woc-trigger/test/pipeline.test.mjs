import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createService } from "../src/server.mjs";
import { validate, nextDue } from "../src/contracts.mjs";
import { commandFor, catalog } from "../src/scripts.mjs";
import { resolve } from "../src/values.mjs";
const action = (id, code) => ({
  id,
  type: "script",
  command: process.execPath,
  args: ["-e", code],
  cwd: tmpdir(),
  timeout_seconds: 3,
});
const config = (steps) => ({
  name: "pipeline",
  enabled: false,
  source: { type: "webhook" },
  steps,
});
async function finished(s, id) {
  for (let i = 0; i < 100; i++) {
    const r = s.store.run(id);
    if (["succeeded", "failed", "unknown", "interrupted"].includes(r.status)) return r;
    await sleep(50);
  }
  throw Error("timeout");
}
test("step contracts reject forward refs, duplicate IDs, unsafe env; values stay data", () => {
  assert.throws(() => validate(config([action("a", "{{steps.b.text}}")])), /forward/);
  assert.throws(() => validate(config([action("a", ""), action("a", "")])), /unique/);
  assert.throws(
    () => validate(config([{ ...action("a", ""), env: { NODE_OPTIONS: "x" } }])),
    /environment/,
  );
  assert.throws(() => resolve("{{input.__proto__}}", { input: {} }), /unavailable/);
  assert.deepEqual(resolve("{{input.json}}", { input: { json: [1, 2] } }), [1, 2]);
  assert.equal(
    resolve("{{input.text}}", { input: { text: "$(touch /tmp/nope)" } }),
    "$(touch /tmp/nope)",
  );
  assert.equal(
    nextDue({ type: "once", at: "2026-11-01T01:00:00Z" }, Date.parse("2026-11-01T00:00:00Z")),
    Date.parse("2026-11-01T01:00:00Z"),
  );
  assert.equal(
    nextDue({ type: "once", at: "2026-11-01T01:00:00Z" }, Date.parse("2026-11-01T01:00:00Z")),
    null,
  );
});
test("pipeline passes exact stdout, separates stderr, exposes files/env and matched Agent receipt", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "woc-pipeline-"));
  let seen;
  const service = createService(
    { stateDir, connections: {} },
    {
      paseo: {
        agents: async () => [],
        execute: async (a, e, signal, dispatch) => {
          seen = { a, e };
          dispatch({ delivery: "accepted", agent_id: a.agent_id });
          return { delivery: "accepted", agent_id: a.agent_id, text: "done" };
        },
      },
    },
  );
  await service.start();
  try {
    const t = service.store.save(
      config([
        action(
          "read",
          `console.error('diagnostic');console.log(JSON.stringify({messages:['hello'],value:'$(echo no)'}))`,
        ),
        {
          ...action(
            "copy",
            `let data='';process.stdin.on('data',d=>data+=d);process.stdin.on('end',()=>{if(require('fs').readFileSync(process.env.WOC_INPUT_FILE,'utf8')!==data)process.exit(4);process.stdout.write(data);});`,
          ),
          env: { MY_VALUE: "{{steps.read.json.value}}" },
        },
        {
          id: "deliver",
          type: "agent",
          agent_id: "test",
          message: "{{input.json.messages}}",
          include_input: false,
          timeout_seconds: 3,
        },
      ]),
    );
    const r = await finished(service, service.store.enqueue(t.id).run_id);
    assert.equal(r.status, "succeeded");
    assert.equal(r.result.steps[1].output.json.value, "$(echo no)");
    assert.equal(seen.a.message, '["hello"]');
    assert.equal(seen.e.run_id, r.id + ":deliver");
    assert.match(r.log, /diagnostic/);
    assert.doesNotMatch(r.result.steps[0].output.text, /diagnostic/);
    assert.equal(r.result.steps[2].output.text, "done");
  } finally {
    await service.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
test("empty skips Agent; failure stops later steps; attempted delivery stays unknown and is not replayed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "woc-skip-"));
  let calls = 0;
  const service = createService(
    { stateDir, connections: {} },
    {
      paseo: {
        agents: async () => [],
        execute: async (a, e, s, dispatch) => {
          calls++;
          dispatch({ delivery: "attempted", agent_id: a.agent_id });
          throw Error("transport gone");
        },
      },
    },
  );
  await service.start();
  const agent = {
    id: "agent",
    type: "agent",
    agent_id: "test",
    message: "x",
    skip_empty: true,
    timeout_seconds: 2,
  };
  try {
    for (const [code, expected] of [
      ["", "succeeded"],
      ["process.exit(9)", "failed"],
    ]) {
      const t = service.store.save(config([action("read", code), agent]));
      const r = await finished(service, service.store.enqueue(t.id).run_id);
      assert.equal(r.status, expected);
      assert.equal(calls, 0);
    }
    const t = service.store.save(config([action("read", `console.log('x')`), agent]));
    const r = await finished(service, service.store.enqueue(t.id).run_id);
    assert.equal(r.status, "unknown");
    assert.equal(calls, 1);
    await sleep(700);
    assert.equal(calls, 1);
  } finally {
    await service.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
test("script catalog never executes scripts, typed argv, async discovery jobs and help", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "woc-catalog-")),
    scriptDir = join(stateDir, "scripts");
  mkdirSync(scriptDir);
  writeFileSync(join(scriptDir, "sample.sh"), "echo help");
  writeFileSync(
    join(scriptDir, "sample.action.json"),
    JSON.stringify({
      title: "sample",
      parameters: [
        { name: "count", type: "number", min: 1, max: 10, required: true },
        { name: "enabled", type: "boolean" },
      ],
    }),
  );
  const cfg = { stateDir, scriptDir, workspace: stateDir, connections: {} };
  assert.equal(catalog(cfg).length, 1);
  assert.deepEqual(
    commandFor(cfg, { script: "sample.sh", params: { count: 2, enabled: true } }, {}).args,
    [realpathSync(join(scriptDir, "sample.sh")), "--count", "2", "--enabled"],
  );
  assert.throws(
    () => commandFor(cfg, { script: "sample.sh", params: { count: 20 } }, {}),
    /number/,
  );
  const s = createService(cfg);
  const port = await s.start();
  const token = readFileSync(join(stateDir, "admin.token"), "utf8");
  const call = async (path, body) => {
    const r = await fetch(`http://localhost:${port}${path}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.json();
  };
  try {
    const j = await call("/script-help", { script: "sample.sh" });
    let result;
    for (let i = 0; i < 20; i++) {
      result = await call("/jobs/" + j.job_id);
      if (result.status !== "running") break;
      await sleep(50);
    }
    assert.equal(result.result.text.trim(), "help");
  } finally {
    await s.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
test("bounded output stops pipeline and once schedule fires only once", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "woc-bounds-"));
  const service = createService({ stateDir, connections: {} });
  await service.start();
  try {
    const bad = service.store.save(
      config([
        action("huge", "process.stdout.write('x'.repeat(300000))"),
        action("never", "throw Error('must not run')"),
      ]),
    );
    const result = await finished(service, service.store.enqueue(bad.id).run_id);
    assert.equal(result.status, "failed");
    assert.match(result.log, /256 KiB/);
    assert.equal(result.result.steps.length, 1);
    const once = service.store.save({
      ...config([action("one", "console.log('once')")]),
      enabled: true,
      source: { type: "once", at: new Date(Date.now() + 700).toISOString() },
    });
    for (let i = 0; i < 40 && !service.store.runs(once.id).length; i++) await sleep(100);
    const runs = service.store.runs(once.id);
    assert.equal(runs.length, 1);
    assert.equal((await finished(service, runs[0].id)).status, "succeeded");
    await sleep(700);
    assert.equal(service.store.runs(once.id).length, 1);
    assert.equal(service.store.get(once.id).next_run, null);
  } finally {
    await service.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
