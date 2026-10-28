import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CuaRegistry } from './registry.js';
import { readCuaConfig, watchdogInterval, type CuaConfig } from './config.js';

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'woc-cua-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config: CuaConfig = { image: 'local/woc-cua:p1', bindIp: '192.168.31.101', publicHost: '192.168.31.101',
    firstPort: 13320, lastPort: 13323, namespace: 'woc-test', stateFile: join(dir, 'state.json'),
    secretsDir: join(dir, 'secrets'), hostSecretsDir: '/host/cua-secrets', serviceTokenFile: '/secret', cpus: 2 };
  return { config, registry: new CuaRegistry(config) };
}
const instance = (id = '0123456789', createdAt = '2026-10-28T00:00:00Z') => ({ id, createdAt });

test('port and credential stay stable across reconstruction and panel restart; generations invalidate old ACKs', t => {
  const { config, registry } = fixture(t);
  const first = registry.prepare(instance(), new Set([13320]));
  const token = registry.token(first.id);
  assert.equal(first.hostPort, 13321);
  assert.equal(statSync(join(config.secretsDir, first.secretRef)).mode & 0o777, 0o600);
  assert.equal(registry.ack(first.id, first.generation, 'registered'), true);
  const restarted = new CuaRegistry(config);
  const second = restarted.prepare(instance(), new Set([13321]));
  assert.equal(second.hostPort, first.hostPort);
  assert.equal(second.secretRef, first.secretRef);
  assert.equal(restarted.token(first.id), token);
  assert.equal(second.generation, first.generation + 1);
  assert.equal(restarted.ack(first.id, first.generation, 'registered'), false);
  assert.ok(!readFileSync(config.stateFile, 'utf8').includes(token));
  assert.equal(restarted.containerOptions(second).bind, `/host/cua-secrets/${first.secretRef}:/run/secrets/cua-token:ro`);
});

test('two accounts never share credentials/ports; deletion revokes, preserves tombstone and rejects queued recreation', t => {
  const { config, registry } = fixture(t);
  const a = registry.prepare(instance(), new Set());
  const token = registry.token(a.id);
  const b = registry.prepare(instance('abcdef0123'), new Set());
  assert.notEqual(a.hostPort, b.hostPort);
  assert.notEqual(registry.token(b.id), token);
  registry.stopped(a.id, true);
  assert.equal(new CuaRegistry(config).get(a.id)?.desired, 'stopped');
  registry.retire(a.id);
  assert.throws(() => registry.token(a.id));
  assert.throws(() => registry.prepare(instance(), new Set()), /deleted/);
  assert.equal(registry.get(a.id)?.desired, 'deleted');
  const replacement = registry.prepare(instance(a.id, '2026-10-29T00:00:00Z'), new Set());
  assert.notEqual(replacement.hostPort, a.hostPort);
  assert.notEqual(registry.token(a.id), token);
  assert.ok(replacement.generation > a.generation);
});

test('exhaustion does not steal occupied or retired ports', t => {
  const { registry } = fixture(t);
  assert.throws(() => registry.prepare(instance(), new Set([13320, 13321, 13322, 13323])), /exhausted/);
  assert.equal(registry.records().length, 0);
});

test('integration is opt-in and rejects broad binds/unpinned images; watchdog zero really disables it', () => {
  assert.equal(readCuaConfig({}), null);
  assert.throws(() => readCuaConfig({ WOC_CUA_ENABLED: '1' }), /required/);
  assert.throws(() => readCuaConfig({ WOC_CUA_ENABLED: '1', WOC_CUA_IMAGE: 'example:latest' }), /latest/);
  assert.throws(() => readCuaConfig({ WOC_CUA_ENABLED: '1', WOC_CUA_IMAGE: 'example:p1', WOC_CUA_BIND_IP: '0.0.0.0' }), /specific IPv4/);
  assert.equal(watchdogInterval('0'), 0);
  assert.equal(watchdogInterval('10'), 60);
  assert.equal(watchdogInterval(undefined), 300);
  assert.throws(() => watchdogInterval('NaN'));
});
