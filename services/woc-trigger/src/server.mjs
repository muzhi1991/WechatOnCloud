import http from "node:http";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "./store.mjs";
import { Engine } from "./engine.mjs";
import { Failure } from "./contracts.mjs";
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
  config.tokenFile ||= join(config.stateDir, "admin.token");
  if (!existsSync(config.tokenFile))
    writeFileSync(config.tokenFile, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  const token = readFileSync(config.tokenFile, "utf8").trim();
  if (token.length < 32) throw Error("Management token too short");
  const dbPath = join(config.stateDir, "trigger.sqlite"),
    store = new Store(dbPath, config.connections || {});
  chmodSync(dbPath, 0o600);
  const engine = new Engine(store, config, deps);
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
          workspace: config.workspace || "/workspace/woc",
          wechat_script: new URL("../examples/wechat-check.py", import.meta.url).pathname,
        });
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
          return send(201, store.save(await body(req)));
        if (path.length === 2 && req.method === "PUT")
          return send(200, store.save(await body(req), path[1]));
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
