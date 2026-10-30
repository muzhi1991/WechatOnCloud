import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { ControlLeases, type Actor } from './leases.js';

// Reload the actual browser API module in a fresh JS context, while retaining
// only browser tab storage. Requests reach the real server ownership engine.
const code = ts.transpileModule(readFileSync(new URL('../../../web/src/api.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

test('refresh restores this tab’s control without reacquiring or changing the epoch', async () => {
  let now = 1000;
  const leases = new ControlLeases(() => now);
  await leases.ensure('abc123', 1, { revoke: async () => {}, reset: async () => {}, grantHuman: async () => {} });
  const stored = new Map<string, string>();
  const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } };
  let takes = 0;
  function load(navigation = 'navigate', tabStorage = storage) {
    const exports: any = {};
    const fetch = async (path: string, init: any) => {
      const actor: Actor = { kind: 'human', id: `admin:${init.headers['x-woc-client']}`, label: 'admin（人工）' };
      const data = path.endsWith('/take') ? (takes++, await leases.take('abc123', actor, true))
        : path.endsWith('/beat') ? leases.renew('abc123', actor, init.headers['x-woc-epoch'])
        : leases.status('abc123', actor);
      return { ok: true, status: 200, type: 'basic', json: async () => data };
    };
    vm.runInNewContext(code, { exports, crypto: webcrypto, sessionStorage: tabStorage,
      performance: { getEntriesByType: () => [{ type: navigation }] }, window: { sessionStorage: tabStorage }, fetch });
    return exports;
  }
  const first = load();
  const original = await first.api.controlTake('abc123');
  assert.equal(original.mine, true);
  const refreshed = load('reload');
  const status = await refreshed.api.controlStatus('abc123');
  assert.equal(status.mine, true, 'refresh incorrectly displays Apply while the previous page still owns the lock');
  assert.equal(status.epoch, original.epoch);
  assert.equal(takes, 1, 'refresh must not take over or reacquire');
  assert.equal((await refreshed.api.controlBeat('abc123')).mine, true);
  // A newly opened/duplicated tab can inherit sessionStorage from its opener.
  // It must not inherit that opener’s desktop write identity.
  const newTab = load('navigate', { getItem: storage.getItem, setItem: () => {} });
  assert.notEqual(newTab.controlClientId, refreshed.controlClientId);
  assert.equal((await newTab.api.controlStatus('abc123')).mine, false);
  now += 31_000;
  const expired = load('reload');
  assert.equal((await expired.api.controlStatus('abc123')).mine, false, 'reload must not revive an expired lease');
  assert.equal(takes, 1);
});
