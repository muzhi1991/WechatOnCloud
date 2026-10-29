import { configuredClient, clientCanAccess } from '../control/clients.js';
import { desktopImage } from '../desktop.js';
import { managed, viewToken } from '../control/runtime.js';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { listInstances } from '../store.js';
import { cuaInstanceStatus } from '../docker.js';
import { cuaConfig } from './config.js';
import { cuaRegistry } from './registry.js';

export function registerCuaRoutes(app: FastifyInstance, admin: (req: FastifyRequest, reply: FastifyReply) => boolean) {
  app.get('/api/admin/cua', async (req, reply) => {
    if (!admin(req, reply)) return;
    return { desktopAvailable: !!desktopImage() && !!cuaConfig && process.env.WOC_CONTROL_ENABLED === '1', enabled: !!cuaConfig, namespace: cuaConfig?.namespace, controlManaged: process.env.WOC_CONTROL_ENABLED === '1' };
  });
  // A separate machine identity: cookies/admin sessions never authorize secret export.
  const machine = (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    if (!cuaConfig || !cuaRegistry) { reply.code(503).send({ error: 'Cua disabled' }); return false; }
    const client = configuredClient(req.headers.authorization?.replace(/^Bearer /, '') || '');
    if (client) return true;
    let expected: string;
    try { expected = readFileSync(cuaConfig.serviceTokenFile, 'utf8').trim(); }
    catch { reply.code(503).send({ error: 'Sync credential unavailable' }); return false; }
    const supplied = req.headers.authorization?.replace(/^Bearer /, '') || '';
    const a = Buffer.from(supplied), b = Buffer.from(expected);
    if (b.length < 32 || a.length !== b.length || !timingSafeEqual(a, b)) {
      reply.code(401).send({ error: 'Unauthorized' }); return false;
    }
    return true;
  };
  app.get('/api/integrations/cua/snapshot', async (req, reply) => {
    if (!machine(req, reply)) return;
    const supplied = req.headers.authorization?.replace(/^Bearer /, '') || '';
    const client = configuredClient(supplied);
    const registry = cuaRegistry!;
    const revision = registry.revision;
    const instances = new Map(listInstances().map(i => [i.id, i]));
    const records = await Promise.all(registry.records().filter(record => !client || clientCanAccess(client, record.id)).map(async record => {
      const { secretRef: _secretRef, incarnation: _incarnation, desired: _desired, ...publicRecord } = record;
      if (record.desired === 'deleted') return { ...publicRecord, state: 'deleted' };
      const inst = instances.get(record.id);
      if (!inst?.cuaEnabled) return { ...publicRecord, state: 'orphaned' };
      const { state } = await cuaInstanceStatus(inst);
      try {
        return { ...publicRecord, state, ...(state === 'ready' ? { token: managed(inst) ? (client ? supplied : viewToken(record.id)) : registry.token(record.id) } : {}) };
      } catch { return { ...publicRecord, state: 'error' }; }
    }));
    if (registry.revision !== revision) return reply.code(409).send({ error: 'Snapshot changed; retry' });
    return { version: 1, deploymentId: registry.deploymentId, namespace: cuaConfig!.namespace, revision, records };
  });
  app.post('/api/integrations/cua/ack', async (req, reply) => {
    if (!machine(req, reply)) return;
    const body = req.body as any;
    if (body?.deploymentId !== cuaRegistry!.deploymentId || !Number.isInteger(body?.generation) ||
        !['registered', 'error'].includes(body?.status) || typeof body?.id !== 'string') {
      return reply.code(400).send({ error: 'Invalid acknowledgement' });
    }
    const client = configuredClient(req.headers.authorization?.replace(/^Bearer /, '') || '');
    if (client && !clientCanAccess(client, body.id)) return reply.code(404).send({ error: 'Machine unavailable' });
    if (!cuaRegistry!.ack(body.id, body.generation, body.status)) return reply.code(409).send({ error: 'Stale generation' });
    return { ok: true };
  });
}
