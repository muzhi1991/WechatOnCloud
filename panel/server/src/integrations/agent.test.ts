import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { registerPaseoAgentRoutes } from './agent.js';
import { configuredClient } from '../control/clients.js';

test('trusted provisioning creates distinct stable agent identities', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'woc-agent-'));
  const previousClients = process.env.WOC_AGENT_CLIENTS_FILE;
  const previousKey = process.env.WOC_AGENT_PROVISION_TOKEN_FILE;
  const secret = randomBytes(32).toString('hex');
  process.env.WOC_AGENT_CLIENTS_FILE = join(dir, 'clients.json');
  process.env.WOC_AGENT_PROVISION_TOKEN_FILE = join(dir, 'key');
  writeFileSync(join(dir, 'key'), secret);
  const app = Fastify(); registerPaseoAgentRoutes(app);
  try {
    const first = randomBytes(32).toString('hex'), second = randomBytes(32).toString('hex');
    const body = (agentId: string, token: string) => ({ agentId, label: 'Test', tokenHash: createHash('sha256').update(token).digest('hex') });
    const send = (payload: object, credential = secret) => app.inject({ method: 'POST', url: '/api/integrations/agent/clients', headers: { authorization: `Bearer ${credential}` }, payload });
    const id = '11111111-1111-1111-1111-111111111111';
    assert.equal((await send(body(id, first), first)).statusCode, 401);
    assert.equal((await send({ agentId: '../bad', label: '', tokenHash: '' })).statusCode, 400);
    assert.equal((await send(body(id, first))).statusCode, 200);
    assert.equal((await send(body(id, first))).statusCode, 200);
    assert.equal((await send(body(id, second))).statusCode, 409);
    assert.equal((await send(body('22222222-2222-2222-2222-222222222222', second))).statusCode, 200);
    assert.notEqual(configuredClient(first)?.id, configuredClient(second)?.id);
    assert.deepEqual(configuredClient(first)?.machines, ['*']);
    assert.equal(statSync(process.env.WOC_AGENT_CLIENTS_FILE).mode & 0o777, 0o600);
  } finally {
    await app.close();
    if (previousClients === undefined) delete process.env.WOC_AGENT_CLIENTS_FILE; else process.env.WOC_AGENT_CLIENTS_FILE = previousClients;
    if (previousKey === undefined) delete process.env.WOC_AGENT_PROVISION_TOKEN_FILE; else process.env.WOC_AGENT_PROVISION_TOKEN_FILE = previousKey;
    rmSync(dir, { recursive: true, force: true });
  }
});
