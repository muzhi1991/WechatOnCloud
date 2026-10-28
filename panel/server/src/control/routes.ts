import { journal, maintenanceState } from '../lifecycle/operations.js';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { cuaRegistry } from '../cua/registry.js';
import { findInstance } from '../store.js';
import { controlEnabled, managed, ensureControl, leases } from './runtime.js';
import { ControlError, type Actor } from './leases.js';

export function registerAgentControlRoutes(app: FastifyInstance) {
  for (const operation of ['acquire', 'renew', 'release', 'status', 'history'] as const) {
    app.post(`/api/integrations/control/:id/${operation}`, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (!controlEnabled) return reply.code(503).send({ error: 'Managed control disabled' });
      let expected: Buffer;
      try { expected = Buffer.from(readFileSync(process.env.WOC_CONTROL_AGENT_TOKEN_FILE || '/run/secrets/cua-agent-token', 'utf8').trim()); }
      catch { return reply.code(503).send({ error: 'Agent identity unavailable' }); }
      const supplied = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
      if (expected.length < 32 || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply.code(401).send({ error: 'Unauthorized' });
      const inst = findInstance((req.params as any).id);
      if (!managed(inst)) return reply.code(404).send({ error: 'Managed desktop not found' });
      const body = req.body as any;
      if (!/^[a-f0-9-]{36}$/.test(body?.clientId || '')) return reply.code(400).send({ error: 'clientId must be a UUID' });
      const actor: Actor = { kind: 'agent', id: body.clientId, label: String(body.label || 'Agent').slice(0, 64) };
      try {
        if (operation === 'history') return { maintenance: maintenanceState(inst!.id), records: journal?.list(inst!.id) || [] };
        await ensureControl(inst!);
        if (operation === 'acquire') { const state = await leases.take(inst!.id, actor); return { ...state, taskId: journal?.task(inst!.id, state.epoch), endpoint: cuaRegistry!.get(inst!.id)!.endpoint }; }
        if (operation === 'renew') return leases.renew(inst!.id, actor, body.epoch);
        if (operation === 'release') return await leases.release(inst!.id, actor, body.epoch);
        return leases.status(inst!.id, actor);
      } catch (e) { return reply.code(e instanceof ControlError ? e.statusCode : 503).send({ error: e instanceof ControlError ? e.message : 'Control unavailable' }); }
    });
  }
}
