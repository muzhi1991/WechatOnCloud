import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from './sync.mjs';

const config = { deploymentId: 'deployment-one', namespace: 'woc-test', allowedHost: '192.168.31.101', firstPort: 13320, lastPort: 13330 };
const row = (id = '0123456789', port = 13320) => ({ id, name: `woc-test-${id}`, endpoint: `http://192.168.31.101:${port}`, generation: 1, state: 'ready', token: 'a'.repeat(64) });
const snapshot = (records, revision = 1) => ({ ...config, version: 1, records, revision });
function setup() {
  const state = { deploymentId: config.deploymentId, revision: -1, records: {} };
  const spaces = [{ id: 'direct:192.168.31.101:13211', name: 'cua-worker-01' }];
  const calls = [];
  const adapter = {
    list: async () => spaces.map(x => ({ ...x })),
    save: async value => { assert.ok(!JSON.stringify(value).includes('a'.repeat(64))); },
    add: async (endpoint, name) => { calls.push(['add', name]); const id = `direct:${new URL(endpoint).host}`;
      const old = spaces.findIndex(s => s.id === id); if (old >= 0) spaces.splice(old, 1); spaces.push({ id, name }); },
    remove: async id => { calls.push(['remove', id]); spaces.splice(spaces.findIndex(s => s.id === id), 1); },
    ack: async (...args) => { calls.push(['ack', ...args]); },
  };
  return { state, spaces, calls, adapter };
}
test('two instances register once; restart state and offline snapshots do not duplicate or delete', async () => {
  const { state, spaces, calls, adapter } = setup();
  const a = row(), b = row('abcdef0123', 13321);
  await reconcile(snapshot([a, b]), state, adapter, config);
  await reconcile(snapshot([a, b]), structuredClone(state), adapter, config);
  assert.equal(calls.filter(c => c[0] === 'add').length, 2);
  await reconcile(snapshot([{ ...a, state: 'offline' }], 2), state, adapter, config);
  assert.equal(spaces.length, 3); // A missing row is not a deletion either.
  assert.equal(spaces[0].name, 'cua-worker-01');
});
test('rebuild updates generation once; explicit deletion forgets only the owned registration', async () => {
  const { state, spaces, calls, adapter } = setup(); const a = row();
  await reconcile(snapshot([a]), state, adapter, config);
  await reconcile(snapshot([{ ...a, generation: 2 }], 2), state, adapter, config);
  assert.equal(calls.filter(c => c[0] === 'add').length, 2);
  await reconcile(snapshot([{ ...a, generation: 3, state: 'deleted' }], 3), state, adapter, config);
  await reconcile(snapshot([a], 1), state, adapter, config); // Delayed old response.
  assert.deepEqual(spaces.map(s => s.name), ['cua-worker-01']);
});
test('partial CLI failure retries after restart and does not starve a second ready instance', async () => {
  const { state, calls, adapter } = setup(); const add = adapter.add; let fail = true;
  adapter.add = async (...args) => { if (fail && args[1].endsWith('0123456789')) throw new Error('offline'); return add(...args); };
  const s = snapshot([row(), row('abcdef0123', 13321)]);
  await assert.rejects(reconcile(s, state, adapter, config), /incomplete/);
  assert.equal(state.records['0123456789'].pending, true);
  assert.equal(state.records['abcdef0123'].pending, false);
  fail = false;
  await reconcile(s, structuredClone(state), adapter, config);
  assert.equal(calls.filter(c => c[0] === 'add').length, 2);
});
test('crash after successful CLI add recovers from its durable pending claim', async () => {
  const { state, adapter } = setup(); const save = adapter.save; let fail = true;
  adapter.save = async value => { if (fail && value.records['0123456789']?.pending === false) throw new Error('disk failure'); return save(value); };
  await assert.rejects(reconcile(snapshot([row()]), state, adapter, config));
  // The durable file still contained pending=true when save failed.
  state.records['0123456789'].pending = true; fail = false;
  await reconcile(snapshot([row()]), state, adapter, config);
  assert.equal(state.records['0123456789'].pending, false);
});
test('wrong deployment, out-of-scope endpoints and unowned collisions cause no registration mutations', async () => {
  const { state, spaces, adapter, calls } = setup();
  await assert.rejects(reconcile({ ...snapshot([]), deploymentId: 'wrong' }, state, adapter, config));
  await assert.rejects(reconcile(snapshot([{ ...row(), endpoint: 'http://192.168.31.101:13211' }]), state, adapter, config));
  spaces.push({ id: 'direct:192.168.31.101:13320', name: 'someone-elses-space' });
  await assert.rejects(reconcile(snapshot([row()]), state, adapter, config), /collision/);
  assert.equal(calls.length, 0);
});
