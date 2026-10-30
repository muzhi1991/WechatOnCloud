import { randomUUID } from 'node:crypto';
import { ControlError, type Actor, type ControlLeases } from './leases.js';

type Request = { id: string; requester: Actor; epoch: string; expiresAt: number; idleManaged: boolean };
const same = (a: Actor, b: Actor) => a.kind === b.kind && a.id === b.id;

// One pending request per machine. No queue, background work or automatic grant.
// Authentication/ACL resolution belongs to the caller; recheck at approval time.
export class ControlRequests {
  private pending = new Map<string, Request>();
  constructor(private leases: ControlLeases, private canAccess: (machine: string, actor: Actor) => boolean,
    private now = Date.now, readonly ttlMs = 60_000) {}

  private current(machine: string) {
    const request = this.pending.get(machine);
    if (!request) return;
    const status = this.leases.status(machine);
    if (request.expiresAt <= this.now() || request.epoch !== status.epoch || !['human', 'agent'].includes(status.state)
      || !this.canAccess(machine, request.requester)) { this.pending.delete(machine); return; }
    return request;
  }
  status(machine: string, actor: Actor) {
    const request = this.current(machine), status = this.leases.status(machine, actor);
    return { ...status, request: request ? { id: request.id, label: request.requester.label, kind: request.requester.kind,
      expiresAt: request.expiresAt, mine: same(request.requester, actor), canRespond: status.mine } : null };
  }
  async request(machine: string, actor: Actor, idleManaged = actor.kind === 'agent', confirmedAgentEpoch?: string) {
    if (!this.canAccess(machine, actor)) throw new ControlError('无权操作该实例', 403);
    const status = this.leases.status(machine, actor);
    if (confirmedAgentEpoch !== undefined) {
      if (actor.kind !== 'human' || status.state !== 'agent' || status.epoch !== confirmedAgentEpoch)
        throw new ControlError('操作者已变化，请重新查看控制状态并申请', 409, 'WOC_CONTROL_CHANGED');
      // Check and start the existing drain/transfer synchronously, before any await.
      await this.leases.take(machine, actor, true, idleManaged);
      return this.status(machine, actor);
    }
    if (actor.kind === 'human' && status.state === 'agent')
      throw new ControlError(`${status.holder} 正在操作，请确认后接管`, 409, 'WOC_AGENT_CONFIRMATION_REQUIRED');
    if (status.free || status.mine) {
      await this.leases.take(machine, actor, false, idleManaged);
      return this.status(machine, actor);
    }
    if (!['human', 'agent'].includes(status.state)) throw new ControlError('正在交接或维护，请稍后查询', 409, 'WOC_CONTROL_BLOCKED');
    const old = this.current(machine);
    if (old && !same(old.requester, actor)) throw new ControlError('已有待处理申请，请稍后再试', 409, 'WOC_REQUEST_BUSY');
    if (!old) this.pending.set(machine, { id: randomUUID(), requester: actor, epoch: status.epoch, expiresAt: this.now() + this.ttlMs, idleManaged });
    return this.status(machine, actor);
  }
  async respond(machine: string, actor: Actor, epoch: string, requestId: string, approve: boolean) {
    const request = this.current(machine), status = this.leases.status(machine, actor);
    if (!status.mine || status.epoch !== epoch) throw new ControlError('只有当前持有人可以处理申请', 403);
    if (!request || request.id !== requestId) throw new ControlError('申请已失效，请刷新状态', 409, 'WOC_REQUEST_EXPIRED');
    this.pending.delete(machine);
    if (approve) await this.leases.transfer(machine, actor, epoch, request.requester, request.idleManaged);
    return this.status(machine, actor);
  }
  cancel(machine: string, actor: Actor, requestId: string) {
    const request = this.current(machine);
    if (!request || request.id !== requestId) throw new ControlError('申请已失效', 409, 'WOC_REQUEST_EXPIRED');
    if (!same(request.requester, actor)) throw new ControlError('只能取消自己的申请', 403);
    this.pending.delete(machine);
    return this.status(machine, actor);
  }
}
