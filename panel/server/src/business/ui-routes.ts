import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { configuredClient, clientActor, clientCanAccess } from '../control/clients.js';
import { ControlError, type ControlLeases } from '../control/leases.js';
import { configuredReadTarget, type ReadTarget } from './routes.js';
import { uiOperations, uiSchema } from './ui-contract.mjs';

export function registerUiRoutes(app: FastifyInstance, deps: {
  exists(id: string): boolean;
  leases: ControlLeases;
  ensure(id: string): Promise<void>;
  target?(id: string): ReadTarget | undefined;
}) {
  for (const [op, spec] of Object.entries(uiOperations) as [string, { read?: boolean; properties: Record<string, unknown> }][]) {
    app.post(`/api/integrations/wechat/:machine/${op}`, {
      schema: { body: uiSchema(op) },
      preValidation: async (req, reply) => {
        if (req.body && typeof req.body === 'object' && Object.keys(req.body).some(k => !Object.hasOwn(spec.properties, k)))
          return reply.code(400).send({ ok: false, code: 'WOC_INVALID_ARGUMENT', error: 'Unknown argument', execution: 'not_started' });
      },
    }, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const fail = (status: number, code: string, error: string, execution = 'not_started') => reply.code(status).send({ ok: false, code, error, execution });
      const client = configuredClient(String(req.headers.authorization || '').replace(/^Bearer /, ''));
      if (!client) return fail(401, 'WOC_UNAUTHORIZED', 'Client credential required');
      const id = (req.params as any).machine;
      if (!deps.exists(id) || !clientCanAccess(client, id)) return fail(404, 'WOC_MACHINE_NOT_FOUND', 'Machine unavailable');
      const target = (deps.target || configuredReadTarget)(id);
      if (!target) return fail(503, 'WOC_UI_NOT_CONFIGURED', 'Application service not configured');
      let dispatched = false;
      try {
        const actor = clientActor(client);
        const lease = spec.read ? undefined : deps.leases.client(id, actor);
        const expected = req.headers['x-woc-expected-epoch'];
        if (lease && expected && expected !== lease.epoch) throw new ControlError('The script’s lock period ended; stop and observe', 409, 'WOC_LOCK_EXPIRED');
        if (lease) await deps.ensure(id);
        const token = readFileSync(target.tokenFile, 'utf8').trim();
        if (token.length < 32) throw new Error('Invalid service configuration');
        const invoke = async () => {
          dispatched = !spec.read;
          const response = await fetch(`${target.url}/v1/apps/wechat/${op}`, {
            method: 'POST', redirect: 'error', headers: {
              'content-type': 'application/json', authorization: `Bearer ${token}`,
              'x-woc-principal': createHash('sha256').update(`client:${client.id}`).digest('hex'),
              ...(lease ? { 'x-woc-control-epoch': lease.epoch } : {}),
            }, body: JSON.stringify(req.body), signal: AbortSignal.timeout(10_000),
          });
          const data = await response.json() as any;
          // Known precondition failures do not fault control. Uncertain writes
          // retain the existing fail-closed recovery semantics.
          if (!spec.read && (data.execution === 'unknown' || (response.status >= 500 && data.execution !== 'not_started'))) throw Error('Execution uncertain');
          return { status: response.status, data };
        };
        const result = lease ? await deps.leases.write(id, actor, lease.epoch, invoke, `wechat.${op}`) : await invoke();
        return reply.code(result.status).send(result.data);
      } catch (error) {
        const code = error instanceof ControlError ? error.code || 'WOC_CONTROL_BLOCKED' : dispatched ? 'WOC_ACTION_UNCERTAIN' : 'WOC_UI_UNAVAILABLE';
        return fail(error instanceof ControlError ? error.statusCode : 503, code,
          dispatched ? 'Operation result unknown; inspect before retry' : error instanceof ControlError ? `${error.message}; use woc_lock_acquire, observe, then operate and release` : 'Application service unavailable',
          dispatched ? 'unknown' : 'not_started');
      }
    });
  }
}
