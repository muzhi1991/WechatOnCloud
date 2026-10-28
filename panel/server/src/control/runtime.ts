import { createHmac } from 'node:crypto';
import type { Socket } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { cuaRegistry } from '../cua/registry.js';
import { cuaConfig } from '../cua/config.js';
import { findInstance, type Instance, type User } from '../store.js';
import { controlExec } from '../docker.js';
import { ControlLeases, ControlError, type Actor } from './leases.js';
import { createControlGateway } from './gateway.js';

export const controlEnabled = process.env.WOC_CONTROL_ENABLED === '1';
export const leases = new ControlLeases();
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
export async function ensureControl(inst: Instance) {
  const record = cuaRegistry?.get(inst.id);
  if (!managed(inst) || !record || record.desired !== 'running') throw new ControlError('受管桌面未运行', 503);
  await leases.ensure(inst.id, record.generation, {
    revoke: async () => {
      await kasm(inst, 'update_user', [{ user: 'woc-human', write: false, read: true, owner: false }]);
      await disconnect(inst.id);
    },
    reset: async hard => {
      await controlExec(inst, hard);
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
    grantHuman: async password => { await kasm(inst, 'update_user', [{ user: 'woc-human', password, write: true, read: true, owner: false }]); },
  });
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
  return leases.write(inst.id, requestActor(u, req), requestEpoch(req), action);
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
}
