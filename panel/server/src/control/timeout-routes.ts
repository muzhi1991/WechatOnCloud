import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ControlTimeouts } from './leases.js';

export function registerTimeoutRoutes(app: FastifyInstance, deps: {
  authorize(req: FastifyRequest, reply: FastifyReply, write: boolean): boolean;
  get(): ControlTimeouts; set(value: ControlTimeouts): void;
}) {
  app.get('/api/control-timeouts', async (req, reply) => {
    if (!deps.authorize(req, reply, false)) return;
    return deps.get();
  });
  app.post('/api/admin/control-timeouts', async (req, reply) => {
    if (!deps.authorize(req, reply, true)) return;
    const body = req.body as Record<string, unknown> | null;
    const limits = { disconnectSeconds: [15, 300], humanIdleSeconds: [30, 3600], agentIdleSeconds: [1, 3600] };
    for (const [key, [min, max]] of Object.entries(limits)) {
      const value = body?.[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
        return reply.code(400).send({ error: `${key} 必须是 ${min}～${max} 秒的整数` });
    }
    const { disconnectSeconds, humanIdleSeconds, agentIdleSeconds } = body as ControlTimeouts;
    deps.set({ disconnectSeconds, humanIdleSeconds, agentIdleSeconds });
    return deps.get();
  });
}
