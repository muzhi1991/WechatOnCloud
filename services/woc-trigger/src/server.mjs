import http from "node:http";
import { timingSafeEqual, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "./store.mjs";
import { Engine } from "./engine.mjs";
import { Failure, validate, nextDue } from "./contracts.mjs";
import { catalog, scriptRoot, commandFor, inspectScript } from "./scripts.mjs";
import { discover, options } from "./discovery.mjs";
const equal = (a, b) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
async function body(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 65536) throw new Failure("Body exceeds 64 KiB", 413);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Failure("Expected JSON");
  }
}
export function createService(config, deps = {}) {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  rmSync(join(config.stateDir, "inputs"), { recursive: true, force: true });
  config.tokenFile ||= join(config.stateDir, "admin.token");
  if (!existsSync(config.tokenFile))
    writeFileSync(config.tokenFile, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  const token = readFileSync(config.tokenFile, "utf8").trim();
  if (token.length < 32) throw Error("Management token too short");
  const dbPath = join(config.stateDir, "trigger.sqlite"),
    store = new Store(dbPath, config.connections || {});
  chmodSync(dbPath, 0o600);
  const engine = new Engine(store, config, deps);
  const jobs = new Map();
  const job = (fn) => {
    for (const [id, j] of jobs) if (Date.now() - j.created > 120000) jobs.delete(id);
    if (jobs.size >= 64) throw new Failure("Discovery busy; retry shortly", 429);
    const id = randomUUID(),
      j = { created: Date.now(), status: "running" };
    jobs.set(id, j);
    Promise.resolve()
      .then(fn)
      .then(
        (result) => {
          if (Buffer.byteLength(JSON.stringify(result)) > 1048576)
            Object.assign(j, { status: "failed", error: "Discovery result exceeds 1 MiB" });
          else Object.assign(j, { status: "succeeded", result });
        },
        (e) => Object.assign(j, { status: "failed", error: e.message }),
      );
    return { job_id: id };
  };
  const validateConfig = (input) => {
    const cfg = validate(input, config.connections || {});
    if (cfg.enabled && cfg.source.type === "once" && Date.parse(cfg.source.at) <= Date.now())
      throw new Failure("指定时间已过，请选择未来时间");
    for (const step of cfg.steps || [cfg.action])
      if (step.type === "script" && step.script) {
        const hasVariables = JSON.stringify(step).includes("{{");
        // Metadata/existence checked now; runtime-dependent values checked at execution.
        if (!hasVariables) commandFor(config, step, {});
        else if (!catalog(config).some((s) => s.id === step.script && !s.error))
          throw new Failure("Script unavailable");
      }
    return cfg;
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    const send = (status, value) => {
      res.writeHead(status);
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url, "http://localhost"),
        path = url.pathname.split("/").filter(Boolean);
      const supplied = req.headers.authorization?.replace(/^Bearer /, "") || "";
      if (path[0] === "hooks") {
        if (req.method !== "POST" || path.length !== 2 || !store.checkHook(path[1], supplied))
          throw new Failure("Webhook unavailable or unauthorized", 401);
        return send(202, store.enqueue(path[1], await body(req), "webhook"));
      }
      if (!equal(supplied, token)) throw new Failure("Unauthorized", 401);
      if (req.method === "GET" && url.pathname === "/health")
        return send(200, { ok: true, sources: engine.status() });
      if (req.method === "GET" && url.pathname === "/catalog")
        return send(200, {
          connections: Object.keys(config.connections || {}),
          scripts: catalog(config),
          script_dir: scriptRoot(config),
          workspace: config.workspace || "/workspace/woc",
          wechat_script: new URL("../examples/wechat-check.py", import.meta.url).pathname,
        });
      if (req.method === "GET" && path[0] === "jobs") {
        const j = jobs.get(path[1]);
        if (!j) throw new Failure("Discovery expired; refresh", 404);
        return send(200, j);
      }
      if (req.method === "POST" && url.pathname === "/discover") {
        const b = await body(req);
        return send(
          202,
          job(() => discover(config, b.connection)),
        );
      }
      if (req.method === "POST" && url.pathname === "/options") {
        const b = await body(req);
        return send(
          202,
          job(() => options(config, b)),
        );
      }
      if (req.method === "POST" && url.pathname === "/script-help") {
        const b = await body(req);
        return send(
          202,
          job(async () => ({ text: await inspectScript(config, b.script, ["--help"]) })),
        );
      }
      if (req.method === "POST" && url.pathname === "/validate")
        return send(200, { config: validateConfig(await body(req)) });
      if (req.method === "POST" && url.pathname === "/schedule-preview") {
        const b = await body(req),
          cfg = validate(
            {
              name: "preview",
              enabled: false,
              source: b,
              action: { type: "agent", agent_id: "preview", message: "preview" },
            },
            config.connections || {},
          );
        let now = Date.now();
        const dates = [];
        for (let i = 0; i < 5; i++) {
          const next = nextDue(cfg.source, now);
          if (!next) break;
          dates.push(new Date(next).toISOString());
          now = next;
        }
        return send(200, { dates });
      }
      if (req.method === "GET" && url.pathname === "/agents")
        return send(200, { agents: await engine.paseo.agents() });
      if (req.method === "POST" && url.pathname === "/agent-tasks") {
        const b = await body(req);
        if (
          b.idempotency_key &&
          (typeof b.idempotency_key !== "string" || b.idempotency_key.length > 256)
        )
          throw new Failure("Invalid idempotency key");
        return send(202, store.enqueueAgent({ ...b.action, type: "agent" }, b.idempotency_key));
      }
      if (path[0] === "triggers") {
        if (path.length === 1 && req.method === "GET") return send(200, { triggers: store.list() });
        if (path.length === 1 && req.method === "POST")
          return send(201, store.save(validateConfig(await body(req))));
        if (path.length === 2 && req.method === "PUT")
          return send(200, store.save(validateConfig(await body(req)), path[1]));
        if (path.length === 2 && req.method === "DELETE") {
          store.remove(path[1]);
          return send(200, { deleted: true });
        }
        if (path.length === 3 && path[2] === "run" && req.method === "POST")
          return send(202, store.enqueue(path[1], await body(req)));
      }
      if (path[0] === "runs" && req.method === "GET") {
        if (path.length === 1)
          return send(200, { runs: store.runs(url.searchParams.get("trigger_id")) });
        const r = store.run(path[1]);
        if (r) return send(200, r);
      }
      throw new Failure("Not found", 404);
    } catch (e) {
      send(e.status || 500, { error: e.message });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    server,
    store,
    engine,
    async start() {
      await new Promise((r) => server.listen(config.port || 0, config.host || "127.0.0.1", r));
      config.port = server.address().port;
      engine.start();
      return config.port;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await engine.close();
      store.close();
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(
    readFileSync(process.env.WOC_TRIGGER_CONFIG || process.argv[2], "utf8"),
  );
  const service = createService(config);
  await service.start();
  console.log(`woc-trigger listening on ${config.host || "127.0.0.1"}:${config.port}`);
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      await service.close();
      process.exit(0);
    });
}
