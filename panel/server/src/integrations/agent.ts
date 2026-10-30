import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ManagedClient } from '../control/clients.js';

// Separate from browser sessions and ordinary agent tokens: only the trusted
// Paseo launcher can provision a stable, distinct identity for a conversation.
export function registerPaseoAgentRoutes(app: FastifyInstance) {
  app.post('/api/integrations/agent/clients', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const path = process.env.WOC_AGENT_CLIENTS_FILE;
    const keyPath = process.env.WOC_AGENT_PROVISION_TOKEN_FILE;
    if (!path || !keyPath) return reply.code(503).send({ error: 'Agent integration disabled' });
    let expected: string;
    try { expected = readFileSync(keyPath, 'utf8').trim(); }
    catch { return reply.code(503).send({ error: 'Provision credential unavailable' }); }
    const supplied = req.headers.authorization?.replace(/^Bearer /, '') || '';
    const a = Buffer.from(expected), b = Buffer.from(supplied);
    if (a.length < 32 || a.length !== b.length || !timingSafeEqual(a, b)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const body = req.body as { agentId?: unknown; label?: unknown; tokenHash?: unknown } | null;
    if (!body || typeof body.agentId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.agentId) ||
        typeof body.label !== 'string' || body.label.length > 48 ||
        typeof body.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.tokenHash)) {
      return reply.code(400).send({ error: 'Invalid agent identity' });
    }
    const client: ManagedClient = { id: `paseo_${body.agentId}`, label: `AI · ${body.label}`, tokenHash: body.tokenHash, machines: ['*'] };
    let clients: ManagedClient[] = [];
    try { clients = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!Array.isArray(clients)) throw new Error('Invalid agent identity store');
    const existing = clients.find(c => c.id === client.id);
    if (existing && existing.tokenHash !== client.tokenHash) return reply.code(409).send({ error: 'Agent identity already exists with a different credential' });
    if (!existing) clients.push(client);
    else existing.label = client.label;
    // No await between read and rename: requests serialize on this panel process.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(`${path}.tmp`, JSON.stringify(clients), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    return { id: client.id };
  });
}
