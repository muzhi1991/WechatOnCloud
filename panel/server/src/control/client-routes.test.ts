import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { registerClientControlRoutes } from './client-routes.js';
import { ControlLeases } from './leases.js';

test('lock HTTP API authenticates identity, scopes machines and rejects spoofed/stale releases', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'woc-clients-')), old = process.env.WOC_CLIENTS_FILE;
  const tokens = { a: 'a'.repeat(64), b: 'b'.repeat(64) };
  process.env.WOC_CLIENTS_FILE = join(dir, 'clients.json');
  writeFileSync(process.env.WOC_CLIENTS_FILE, JSON.stringify(Object.entries(tokens).map(([id, token]) => ({ id, label: id, machines: ['desktop'], tokenHash: createHash('sha256').update(token).digest('hex') }))));
  const app = Fastify(), leases = new ControlLeases(); let ensured = 0;
  registerClientControlRoutes(app, { leases, machines: () => [{ id: 'desktop', name: 'Desktop', endpoint: 'http://localhost:3211' }, { id: 'private', name: 'Private', endpoint: 'http://localhost:3212' }],
    ensure: async id => { ensured++; await leases.ensure(id, 1, { revoke: async () => {}, reset: async () => {}, grantHuman: async () => {} }); } });
  t.after(async () => { await app.close(); if (old === undefined) delete process.env.WOC_CLIENTS_FILE; else process.env.WOC_CLIENTS_FILE = old; rmSync(dir, { recursive: true }); });
  const call = (op: string, token: string, payload: any = { machine_id: 'desktop' }) => app.inject({ method: 'POST', url: '/api/integrations/woc/' + op, headers: { authorization: 'Bearer ' + token }, payload });
  assert.equal((await call('status', 'invalid')).statusCode, 401);
  assert.equal((await call('status', tokens.a)).json().state, 'free'); assert.equal(ensured, 0);
  assert.equal((await call('machines', tokens.a)).json().machines.length, 1);
  assert.equal((await call('acquire', tokens.a, { machine_id: 'private' })).statusCode, 404);
  const first = (await call('acquire', tokens.a)).json(); assert.equal(first.mine, true); assert.ok(first.lock_id); assert.equal(first.token, undefined);
  assert.equal((await call('acquire', tokens.b, { machine_id: 'desktop', clientId: 'a' })).json().code, 'WOC_LOCK_BUSY');
  assert.equal((await call('release', tokens.b, { machine_id: 'desktop', lock_id: first.lock_id, clientId: 'a' })).statusCode, 409);
  assert.equal((await call('release', tokens.a, { machine_id: 'desktop', lock_id: first.lock_id })).json().state, 'free');
  const second = (await call('acquire', tokens.a)).json(); assert.notEqual(second.lock_id, first.lock_id);
  assert.equal((await call('release', tokens.a, { machine_id: 'desktop', lock_id: first.lock_id })).statusCode, 409);
  assert.equal((await call('status', tokens.a)).json().mine, true);
});
