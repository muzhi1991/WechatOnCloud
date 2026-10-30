import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
// Thin authenticated proxy. Scheduling, execution and storage remain in woc-trigger.
export function registerAutomationRoutes(
  app: FastifyInstance,
  admin: (req: FastifyRequest, reply: FastifyReply) => boolean,
) {
  app.route({
    method: ["GET", "POST", "PUT", "DELETE"],
    url: "/api/automation/*",
    bodyLimit: 65536,
    handler: async (req, reply) => {
      const path = (req.params as { "*": string })["*"];
      const hook = /^hooks\/[a-f0-9-]{36}$/.test(path);
      if (!hook && !admin(req, reply)) return;
      if (hook && req.method !== "POST") return reply.code(405).send({ error: "Use POST" });
      const endpoint = process.env.WOC_AGENT_PUBLIC_URL;
      if (!endpoint) return reply.code(503).send({ error: "自动化服务未配置" });
      const url = new URL(hook ? "/" + path : "/automation/" + path, endpoint);
      url.search = new URL(req.url, "http://localhost").search;
      try {
        const r = await fetch(url, {
          method: req.method,
          redirect: "error",
          headers: {
            "content-type": "application/json",
            ...(hook
              ? { authorization: req.headers.authorization || "" }
              : { cookie: req.headers.cookie || "" }),
          },
          body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
          signal: AbortSignal.timeout(15000),
        });
        reply.header("cache-control", "no-store");
        return reply.code(r.status).send(await r.json());
      } catch {
        return reply.code(503).send({ error: "自动化服务暂时不可用" });
      }
    },
  });
}
