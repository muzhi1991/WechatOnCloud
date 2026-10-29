import { createHmac } from 'node:crypto';
import type { Socket } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { cuaRegistry } from '../cua/registry.js';
import { cuaConfig } from '../cua/config.js';
import { findInstance, listInstances, type Instance, type User } from '../store.js';
import { controlExec, controlPauseApp, instanceRuntime, cuaInstanceStatus, controlRuntimeIdentity } from '../docker.js';
import { ControlLeases, ControlError, type Actor } from './leases.js';
import { createControlGateway } from './gateway.js';

import { lifecycleEnabled, journal, maintenanceState, configureMaintenance, withInputContext, withMaintenance } from '../lifecycle/operations.js';

export const controlEnabled = process.env.WOC_CONTROL_ENABLED === '1';
const idleMs = Number(process.env.WOC_CONTROL_IDLE_MS || 120_000);
if (!Number.isFinite(idleMs) || idleMs < 1000 || idleMs > 3_600_000) throw new Error('WOC_CONTROL_IDLE_MS must be 1000..3600000');
export const leases = new ControlLeases(Date.now, 30_000, {
  grant: (id, actor, epoch, generation) => { if (actor.kind === 'agent') journal?.start(id, 'task', actor.label, { epoch, details: { generation } }); },
  end: (id, epoch, reason) => journal?.endTask(id, epoch, reason),
  action: (id, actor, epoch, name) => journal?.start(id, 'action', name, { epoch, parent: journal.task(id, epoch), details: { actor: actor.kind } }),
  result: (action, ok) => journal?.finish(action, ok ? 'done' : 'uncertain', ok ? undefined : 'inspect-before-retry'),
}, idleMs);
export const derived = (id: string, purpose: string) => createHmac('sha256', cuaRegistry!.token(id)).update(purpose).digest('hex');
export const viewToken = (id: string) => derived(id, 'woc-cua-view-v1');
export const managed = (inst?: Instance) => controlEnabled && !!inst?.cuaEnabled;
const sockets = new Map<string, Set<Socket>>();
export function trackControlSocket(id: string, socket: Socket) {
  let set = sockets.get(id); if (!set) sockets.set(id, set = new Set());
  set.add(socket); socket.once('close', () => { set!.delete(socket); });
}
async function disconnect(id: string) {
  const set = [...(sockets.get(id) || [])];
  await Promise.all(set.map(socket => new Promise<void>(resolve => {
    if (socket.destroyed) { resolve(); return; }
    socket.once('close', () => resolve()); socket.destroy();
  })));
}
async function kasm(inst: Instance, path: string, body?: unknown) {
  const auth = Buffer.from(`woc-control:${derived(inst.id, 'woc-control-owner-v1')}`).toString('base64');
  const r = await fetch(`http://${inst.containerName}:6901/api/${path}`, { method: body ? 'POST' : 'GET',
    // KasmVNC 1.3.3 incorrectly treats the Basic-auth header name as case-sensitive.
    headers: { Authorization: `Basic ${auth}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!r.ok) throw new ControlError('KasmVNC 权限更新失败', 503);
  const text = await r.text();
  if (/"success"\s*:\s*false/i.test(text)) throw new ControlError('KasmVNC 拒绝权限更新', 503);
  return text;
}
const runtimeIdentity = new Map<string, string>();
export async function ensureControl(inst: Instance, duringMaintenance = false) {
  const maintenance = maintenanceState(inst.id);
  if (maintenance && !duringMaintenance) { leases.hold(inst.id, maintenance.name); return; }
  if (lifecycleEnabled) {
    const identity = await controlRuntimeIdentity(inst);
    const previous = runtimeIdentity.get(inst.id);
    runtimeIdentity.set(inst.id, identity);
    if (previous && identity !== previous && !duringMaintenance) {
      await withMaintenance(inst, 'runtime-changed', async () => {}, { force: true });
    }
  }
  const record = cuaRegistry?.get(inst.id);
  if (!managed(inst) || !record || record.desired !== 'running') throw new ControlError('受管桌面未运行', 503);
  await leases.ensure(inst.id, record.generation, {
    revoke: async () => {
      await kasm(inst, 'update_user', [{ user: 'woc-human', write: false, read: true, owner: false }]);
      await disconnect(inst.id);
    },
    reset: async hard => {
      await controlExec(inst, hard);
      if (lifecycleEnabled) await controlPauseApp(inst, false);
      if (hard) {
        const deadline = Date.now() + 10_000;
        while (true) {
          try {
            const response = await fetch(`http://${inst.containerName}:3211/health`, { signal: AbortSignal.timeout(1000) });
            if (response.ok) break;
          } catch { /* the new driver is still starting */ }
          if (Date.now() >= deadline) throw new ControlError('Cua 输入服务未恢复', 503);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    },
    grantAgent: async () => { if (lifecycleEnabled) await controlPauseApp(inst, true); },
    grantHuman: async password => { await kasm(inst, 'update_user', [{ user: 'woc-human', password, write: true, read: true, owner: false }]); },
  }, false, duringMaintenance);
}
export function humanActor(u: User, client: unknown): Actor {
  if (typeof client !== 'string' || !/^[a-f0-9-]{36}$/.test(client)) throw new ControlError('缺少浏览器标签页标识', 400);
  return { kind: 'human', id: `${u.id}:${client}`, label: `${u.username}（人工）` };
}
export function requestActor(u: User, req: FastifyRequest) { return humanActor(u, req.headers['x-woc-client']); }
export function requestEpoch(req: FastifyRequest) { return String(req.headers['x-woc-epoch'] || ''); }
export async function humanWrite<T>(u: User, req: FastifyRequest, inst: Instance, action: () => Promise<T>) {
  if (!managed(inst)) return action();
  await ensureControl(inst);
  return leases.write(inst.id, requestActor(u, req), requestEpoch(req), check => withInputContext(check, action), req.routeOptions.url || 'human-input');
}
export function vncAuthorization(inst: Instance, u: User, client: string | null, epoch: string | null) {
  let username = 'woc-view', password = derived(inst.id, 'woc-control-viewer-v1');
  try { password = leases.humanPassword(inst.id, humanActor(u, client), epoch || ''); username = 'woc-human'; } catch { /* default read only */ }
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}
export async function startControlGateways() {
  if (!controlEnabled) return;
  if (!cuaConfig || !cuaRegistry) throw new Error('Managed control requires Cua integration');
  for (let port = cuaConfig.firstPort; port <= cuaConfig.lastPort; port++) {
    const server = createControlGateway(() => {
      const record = cuaRegistry!.records().find(r => r.hostPort === port && r.desired === 'running');
      const inst = record && findInstance(record.id);
      if (!inst || !managed(inst)) return undefined;
      return { id: inst.id, upstream: `http://${inst.containerName}:3211`, rawToken: cuaRegistry!.token(inst.id),
        viewToken: viewToken(inst.id), ensure: () => ensureControl(inst) };
    }, leases);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
  }
  setInterval(() => leases.tick(), 1000).unref();
  if (lifecycleEnabled) {
    let checking = false;
    setInterval(async () => {
      if (checking) return; checking = true;
      try { for (const inst of listInstances()) if (managed(inst) && leases.busy(inst.id) && !maintenanceState(inst.id)) await ensureControl(inst).catch(() => {}); }
      finally { checking = false; }
    }, 5000).unref();
  }
}

configureMaintenance({
  finish: inst => leases.endMaintenance(inst.id),
  busy: id => leases.busy(id),
  enter: async (inst, reason, force) => {
    await leases.suspend(inst.id, reason, force);
    await disconnect(inst.id);
    if (await instanceRuntime(inst) === 'running') await controlPauseApp(inst, true).catch(() => {});
  },
  leave: async inst => {
    leases.prepareResume(inst.id);
    if (await instanceRuntime(inst) !== 'running') return;
    runtimeIdentity.set(inst.id, await controlRuntimeIdentity(inst));
    const deadline = Date.now() + 60_000;
    while ((await cuaInstanceStatus(inst)).state !== 'ready') {
      if (Date.now() >= deadline) throw new ControlError('实例尚未恢复就绪，维护保持锁定');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    await ensureControl(inst, true);
    if (!leases.ready(inst.id)) throw new ControlError('控制服务尚未恢复，维护保持锁定');
  },
});
