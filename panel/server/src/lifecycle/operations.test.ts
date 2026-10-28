import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Instance } from '../store.js';

test('maintenance serializes mutations, nests once, persists failures and unlocks only after repair', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'woc-maintenance-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  process.env.WOC_LIFECYCLE_ENABLED = '1';
  process.env.WOC_LIFECYCLE_JOURNAL = join(directory, 'journal.json');
  const { configureMaintenance, withMaintenance, maintenanceState, withInputContext, assertInputCurrent } = await import('./operations.js');
  const inst = { id: 'test', cuaEnabled: true } as Instance;
  let entered = 0, finished = 0, busy = false, held = false;
  configureMaintenance({ busy: () => busy, enter: async () => { entered++; held = true; },
    leave: async () => { assert.equal(held, true); assert.ok(maintenanceState(inst.id)); },
    finish: () => { assert.equal(maintenanceState(inst.id), null); held = false; finished++; } });
  let resolve!: () => void;
  const wait = new Promise<void>(r => { resolve = r; });
  const first = withMaintenance(inst, 'restart', async () => {
    await withMaintenance(inst, 'nested', async () => { assert.equal(entered, 1); });
    await wait;
  });
  await assert.rejects(withMaintenance(inst, 'overlap', async () => {}), /已有维护/);
  resolve(); await first;
  assert.equal(finished, 1); assert.equal(held, false);
  busy = true;
  await assert.rejects(withMaintenance(inst, 'watchdog-soft', async () => {}, { idleOnly: true }), /活动任务/);
  assert.equal(maintenanceState(inst.id), null);
  await assert.rejects(withMaintenance(inst, 'restore', async () => { throw Error('partial write'); }), /partial write/);
  assert.equal(held, true); assert.equal(maintenanceState(inst.id)?.active, false);
  await assert.rejects(withMaintenance(inst, 'new-write', async () => {}), /等待管理员/);
  await withMaintenance(inst, 'review', async () => {}, { repair: true });
  assert.equal(held, false); assert.equal(maintenanceState(inst.id), null);
  let current = true;
  await assert.rejects(withInputContext(() => { if (!current) throw Error('stale input'); }, async () => {
    assertInputCurrent(); current = false; await Promise.resolve(); assertInputCurrent();
  }), /stale input/);
});
