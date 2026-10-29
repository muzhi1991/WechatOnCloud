// Isolated acceptance entry point. Not a second WOC console; no Docker socket.
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
const source = process.env.WOC_SERVER_SOURCE || '../../panel/server/src/';
const { registerReadRoutes } = await import(new URL(source + 'business/routes.ts', import.meta.url));
const { configuredClient, clientCanAccess } = await import(new URL(source + 'control/clients.ts', import.meta.url));
const machines = JSON.parse(readFileSync(process.env.WOC_TEST_MACHINES_FILE, 'utf8'));
const app = Fastify();
registerReadRoutes(app, { exists: id => machines.some(m => m.id === id) });
app.post('/api/integrations/woc/machines', async (req, reply) => {
  const client = configuredClient(String(req.headers.authorization || '').replace(/^Bearer /, ''));
  if (!client) return reply.code(401).send({ code: 'WOC_UNAUTHORIZED' });
  return { machines: machines.filter(m => clientCanAccess(client, m.id)) };
});
await app.listen({ port: 8080, host: '0.0.0.0' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close());
