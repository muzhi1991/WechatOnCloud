import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import Fastify from "fastify";
import { registerAutomationRoutes } from "./automation.js";
test("automation proxy protects management and preserves separate webhook authentication", async () => {
  let received: { path?: string; cookie?: string; authorization?: string } = {};
  const server = http.createServer((req, res) => {
    received = {
      path: req.url,
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
    };
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const old = process.env.WOC_AGENT_PUBLIC_URL;
  process.env.WOC_AGENT_PUBLIC_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  const app = Fastify();
  registerAutomationRoutes(app, (req, reply) => {
    if (req.headers.cookie === "woc_sess=admin") return true;
    reply.code(403).send({ error: "Forbidden" });
    return false;
  });
  try {
    assert.equal((await app.inject("/api/automation/triggers")).statusCode, 403);
    assert.equal(
      (
        await app.inject({
          url: "/api/automation/triggers",
          headers: { cookie: "woc_sess=admin", authorization: "Bearer browser-value" },
        })
      ).statusCode,
      200,
    );
    assert.deepEqual(received, {
      path: "/automation/triggers",
      cookie: "woc_sess=admin",
      authorization: undefined,
    });
    const hook = "/api/automation/hooks/11111111-1111-1111-1111-111111111111";
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: hook,
          headers: { authorization: "Bearer hook-key", cookie: "should-not-forward" },
          payload: { value: "data" },
        })
      ).statusCode,
      200,
    );
    assert.equal(received.authorization, "Bearer hook-key");
    assert.equal(received.cookie, undefined);
    assert.equal((await app.inject(hook)).statusCode, 405);
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/automation/hooks/../../triggers" }))
        .statusCode,
      404,
    );
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    if (old === undefined) delete process.env.WOC_AGENT_PUBLIC_URL;
    else process.env.WOC_AGENT_PUBLIC_URL = old;
  }
});
