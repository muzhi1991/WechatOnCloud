import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { authenticateClient, clientActor, clientCanAccess } from './clients.js';
test('stable identity is derived only from authenticated credentials, scoped per machine', () => {
  const token = 'a'.repeat(64), client = { id: 'mac-a', label: 'Mac A', tokenHash: createHash('sha256').update(token).digest('hex'), machines: ['desktop'] };
  assert.equal(authenticateClient(token, [client])?.id, 'mac-a');
  assert.equal(authenticateClient('b'.repeat(64), [client]), undefined);
  assert.equal(clientCanAccess(client, 'desktop'), true); assert.equal(clientCanAccess(client, 'wechat'), false);
  assert.equal(clientActor(client).id, 'client:mac-a');
});
