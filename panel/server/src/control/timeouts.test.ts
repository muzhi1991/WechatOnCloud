import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { ControlLeases, type ControlTimeouts, type Actor } from './leases.js';
import { registerTimeoutRoutes } from './timeout-routes.js';
const human: Actor = { kind: 'human', id: 'user:1', label: 'one' };
const agent: Actor = { kind: 'agent', id: 'client:1', label: 'agent' };
async function fixture() {
  let now = 1000;
  const policy: ControlTimeouts = { disconnectSeconds: 30, humanIdleSeconds: 300, agentIdleSeconds: 120 };
  const leases = new ControlLeases(() => now, 30000, {}, 120000, () => policy);
  await leases.ensure('a', 1, { revoke: async () => {}, reset: async () => {}, grantHuman: async () => {} });
  return { leases, policy, advance: (n: number) => { now += n; } };
}
test('visible heartbeat and repeated take do not renew human activity; expired input cannot revive lease', async () => {
  const { leases: l, advance } = await fixture(); const s = await l.take('a', human);
  for (let n = 0; n < 59; n++) { advance(5000); l.renew('a', human, s.epoch); await l.take('a', human); }
  assert.equal(l.status('a', human).mine, true);
  advance(5000); assert.equal(l.status('a', human).mine, false);
  assert.throws(() => l.renew('a', human, s.epoch, true), /失效/);
});
test('real activity shared by user tabs renews idle deadline but not forever; disconnect independent', async () => {
  const { leases: l, advance, policy } = await fixture(); policy.humanIdleSeconds = 40;
  const s = await l.take('a', human);
  advance(25000); l.renew('a', { ...human }, s.epoch, true);
  advance(20000); l.renew('a', human, s.epoch);
  assert.equal(l.status('a', human).mine, true);
  advance(20000); assert.equal(l.status('a', human).mine, false);
  await new Promise(r => setImmediate(r));
  const next = await l.take('a', human);
  advance(30000); assert.equal(l.status('a', human).mine, false);
  assert.notEqual(s.epoch, next.epoch);
});
test('HTTP GUI write counts as human activity; reads do not; policy shortening uses original timestamps', async () => {
  const { leases: l, advance, policy } = await fixture(); policy.humanIdleSeconds = 40;
  const s = await l.take('a', human);
  advance(25000); l.renew('a', human, s.epoch);
  await l.write('a', human, s.epoch, async () => {});
  advance(20000); l.renew('a', human, s.epoch); assert.equal(l.status('a', human).mine, true);
  policy.humanIdleSeconds = 15; l.tick(); assert.equal(l.status('a', human).mine, false);
});
test('agent deadline only follows writes and respects live policy', async () => {
  const { leases: l, advance, policy } = await fixture(); await l.take('a', agent, false, true);
  advance(110000); let lease = l.client('a', agent);
  await l.write('a', agent, lease.epoch, async () => {});
  advance(110000); assert.equal(l.status('a', agent).mine, true);
  policy.agentIdleSeconds = 100; assert.equal(l.status('a', agent).mine, false);
});
test('settings API requires admin to write and rejects invalid values without mutation', async () => {
  const app = Fastify(); let value: ControlTimeouts = { disconnectSeconds: 30, humanIdleSeconds: 300, agentIdleSeconds: 120 };
  registerTimeoutRoutes(app, {
    authorize: (req, reply, write) => { if (!req.headers.authorization || (write && req.headers.authorization !== 'admin')) { reply.code(403).send({error:'denied'}); return false; } return true; },
    get: () => value, set: next => { value = next; },
  });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/control-timeouts' })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/control-timeouts', headers: { authorization: 'user' } })).statusCode, 200);
    const post = (payload: unknown, authorization = 'admin') => app.inject({ method: 'POST', url: '/api/admin/control-timeouts', headers: { authorization }, payload: payload as any });
    assert.equal((await post(value, 'user')).statusCode, 403);
    for (const bad of [null, {}, { ...value, disconnectSeconds: 0 }, { ...value, humanIdleSeconds: '300' }, { ...value, agentIdleSeconds: 1.5 }]) assert.equal((await post(bad)).statusCode, 400);
    assert.deepEqual(value, { disconnectSeconds: 30, humanIdleSeconds: 300, agentIdleSeconds: 120 });
    assert.equal((await post({ disconnectSeconds: 20, humanIdleSeconds: 600, agentIdleSeconds: 60 })).statusCode, 200);
    assert.equal(value.humanIdleSeconds, 600);
  } finally { await app.close(); }
});
