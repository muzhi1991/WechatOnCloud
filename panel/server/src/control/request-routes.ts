import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ControlError, type Actor, type ControlLeases } from './leases.js';
import type { ControlRequests } from './requests.js';

export function registerControlRequestRoutes(app: FastifyInstance, deps: {
  leases: ControlLeases; requests: ControlRequests;
  authorize(req: FastifyRequest, reply: FastifyReply, machine: string): { actor: Actor; admin: boolean } | undefined;
  ensure(machine: string): Promise<void>;
}) {
  for (const action of ['respond', 'cancel', 'force'] as const) {
    app.post(`/api/instances/:id/control/${action}`, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const machine = (req.params as any).id, user = deps.authorize(req, reply, machine);
      if (!user) return;
      const body = (req.body || {}) as any;
      try {
        if (action === 'force' && !user.admin) throw new ControlError('只有管理员可以强制接管', 403);
        if (action !== 'force' && (typeof body.request_id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.request_id)))
          throw new ControlError('需要有效的申请 ID', 400);
        if (action === 'respond' && typeof body.approve !== 'boolean') throw new ControlError('需要明确同意或拒绝', 400);
        await deps.ensure(machine);
        if (action === 'respond') return await deps.requests.respond(machine, user.actor, String(req.headers['x-woc-epoch'] || ''), body.request_id, body.approve);
        if (action === 'cancel') return deps.requests.cancel(machine, user.actor, body.request_id);
        await deps.leases.take(machine, user.actor, true);
        return deps.requests.status(machine, user.actor);
      } catch (e) {
        return reply.code(e instanceof ControlError ? e.statusCode : 503).send({ code: e instanceof ControlError ? e.code : 'WOC_CONTROL_BLOCKED', error: e instanceof ControlError ? e.message : '控制服务不可用' });
      }
    });
  }
}
