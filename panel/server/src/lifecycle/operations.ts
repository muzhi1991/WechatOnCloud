import { AsyncLocalStorage } from 'node:async_hooks';
import type { Instance } from '../store.js';
import { ControlError } from '../control/leases.js';
import { ControlJournal } from './journal.js';
export const lifecycleEnabled = process.env.WOC_LIFECYCLE_ENABLED === '1';
export const journal = lifecycleEnabled ? new ControlJournal(process.env.WOC_LIFECYCLE_JOURNAL || '/data/panel/cua/lifecycle.json') : undefined;
export interface MaintenanceHooks {
  busy(id: string): boolean;
  enter(inst: Instance, reason: string, force: boolean): Promise<void>;
  leave(inst: Instance): Promise<void>;
  finish(inst: Instance): void;
}
const context = new AsyncLocalStorage<string>();
const active = new Set<string>();
let hooks: MaintenanceHooks;
export const configureMaintenance = (value: MaintenanceHooks) => { hooks = value; };
export function maintenanceState(id: string) {
  const row = journal?.unresolved(id);
  return row ? { id: row.id, name: row.name, state: row.state, reason: row.reason, active: active.has(id) } : null;
}
export function assertAvailable(id: string) {
  if (maintenanceState(id)) throw new ControlError('实例正在维护或等待管理员核对，请查看维护记录');
}
export async function withMaintenance<T>(inst: Instance, reason: string, work: () => Promise<T>, options: { force?: boolean; idleOnly?: boolean; repair?: boolean } = {}): Promise<T> {
  if (!lifecycleEnabled || !inst.cuaEnabled) return work();
  if (context.getStore() === inst.id) return work();
  if (active.has(inst.id)) throw new ControlError('该实例已有维护操作正在执行');
  if (!options.repair) assertAvailable(inst.id);
  if (!hooks || !journal) throw new Error('Maintenance hooks unavailable');
  if (options.idleOnly && hooks.busy(inst.id)) throw new ControlError('实例仍有活动任务，跳过柔和自愈');
  active.add(inst.id);
  let record: string | undefined;
  try {
    record = journal.start(inst.id, 'maintenance', reason);
    await hooks.enter(inst, reason, !!options.force);
    const result = await context.run(inst.id, work);
    await hooks.leave(inst);
    journal.finish(record, 'done');
    if (options.repair) journal.resolve(inst.id);
    hooks.finish(inst);
    return result;
  } catch (error) {
    if (record) journal.finish(record, 'interrupted', 'operation-failed-inspect-before-retry');
    throw error;
  } finally { active.delete(inst.id); }
}
// Docker input helpers must not run after their original controller entry retired.
const inputContext = new AsyncLocalStorage<() => void>();
export const withInputContext = <T>(check: () => void, work: () => Promise<T>) => inputContext.run(check, work);
export const assertInputCurrent = () => inputContext.getStore()?.();
