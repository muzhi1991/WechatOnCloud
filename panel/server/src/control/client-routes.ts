import type { FastifyInstance } from 'fastify';
import { configuredClient, clientActor, clientCanAccess } from './clients.js';
import { ControlError, type ControlLeases } from './leases.js';

// Dependency injection keeps authentication, locking and HTTP independently testable.
export function registerClientControlRoutes(app: FastifyInstance, dependencies: {
  leases: ControlLeases;
  machines(): { id: string; name: string; endpoint: string }[];
  ensure(id: string): Promise<void>;
}) {
  app.post('/api/integrations/woc/:operation', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const client = configuredClient(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!client) return reply.code(401).send({ code: 'WOC_UNAUTHORIZED', error: 'Invalid client credential' });
    const op = (req.params as any).operation, body = (req.body || {}) as any;
    const machines = dependencies.machines().filter(m => clientCanAccess(client, m.id));
    if (op === 'machines') return { clientId: client.id, machines };
    const machine = machines.find(m => m.id === body.machine_id);
    if (!machine) return reply.code(404).send({ code: 'WOC_MACHINE_NOT_FOUND', error: 'Machine not available to this client' });
    const actor = clientActor(client), l = dependencies.leases;
    const state = () => {
      if (!l.initialized(machine.id) && !l.busy(machine.id)) return { machine_id: machine.id, state: 'free', mine: false, initialized: false, idle_timeout_ms: l.idleMs };
      const s = l.status(machine.id, actor);
      return { machine_id: machine.id, state: s.free ? 'free' : ['agent', 'human'].includes(s.state) ? 'held' : 'blocked',
        mine: s.mine, holder: s.holder, lock_id: s.mine ? s.epoch : undefined, idle_expires_at: s.expiresAt, idle_timeout_ms: l.idleMs, inflight: s.inflight };
    };
    try {
      if (op === 'status') return state();
      if (op === 'acquire') {
        await dependencies.ensure(machine.id);
        const s = await l.take(machine.id, actor, false, true);
        if (!s.mine) throw new ControlError('Control handover pending; query status before operating', 409, 'WOC_CONTROL_BLOCKED');
        return state();
      }
      if (op === 'release') {
        if (typeof body.lock_id !== 'string' || !body.lock_id) throw new ControlError('lock_id from acquire is required', 400, 'WOC_INVALID_LOCK');
        await l.release(machine.id, actor, body.lock_id);
        return state();
      }
      return reply.code(404).send({ error: 'Unknown operation' });
    } catch (e) {
      return reply.code(e instanceof ControlError ? e.statusCode : 503).send({
        code: e instanceof ControlError ? e.code || (op === 'acquire' ? 'WOC_LOCK_BUSY' : 'WOC_INVALID_LOCK') : 'WOC_CONTROL_BLOCKED',
        error: e instanceof ControlError ? e.message : 'Control unavailable', ...state(),
      });
    }
  });
}
