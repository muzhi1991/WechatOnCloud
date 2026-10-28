import { randomBytes, randomUUID } from 'node:crypto';

export type Actor = { kind: 'human' | 'agent'; id: string; label: string };
export interface ControlAdapter {
  revoke(): Promise<void>; // Revoke Kasm write access AND close old writable sockets.
  reset(hard: boolean): Promise<void>; // XSync input reset; hard also terminates the old Cua driver.
  grantHuman(password: string): Promise<void>;
  grantAgent?(): Promise<void>;
}
export interface ControlObserver {
  grant?(id: string, actor: Actor, epoch: string, generation: number): void;
  end?(id: string, epoch: string, reason: string): void;
  action?(id: string, actor: Actor, epoch: string, name: string): string | undefined;
  result?(action: string, ok: boolean): void;
}
export class ControlError extends Error {
  constructor(message: string, readonly statusCode = 409) { super(message); }
}
type Entry = {
  generation: number; epoch: string; state: 'idle' | 'human' | 'agent' | 'handover' | 'faulted';
  owner?: Actor; token?: string; password?: string; expires: number; inflight: number;
  uncertain: boolean; initialized: boolean; retired: boolean; adapter: ControlAdapter; transition?: Promise<void>; drain: Set<() => void>;
  lane: { tail: Promise<void> };
};

// All callers (human HTTP, native VNC, and Cua RPC) cross this interface.
// Epochs include a random controller incarnation; no lease survives restart.
export class ControlLeases {
  private entries = new Map<string, Entry>();
  private holds = new Map<string, string>();
  constructor(private readonly now = Date.now, readonly ttlMs = 30_000, private observer: ControlObserver = {}) {}
  async ensure(id: string, generation: number, adapter: ControlAdapter, replace = false, duringMaintenance = false) {
    if (this.holds.has(id) && !duringMaintenance) return;
    let e = this.entries.get(id);
    if (!replace && e?.generation === generation) { if (!e.initialized) await e.transition; return; }
    if (e) { const oldEpoch = e.epoch; e.retired = true; e.uncertain = true; e.owner = undefined; e.token = undefined; e.state = 'faulted'; e.epoch = randomUUID(); this.observer.end?.(id, oldEpoch, 'generation-changed'); }
    const lane = e?.lane || { tail: Promise.resolve() };
    e = { generation, epoch: randomUUID(), state: 'handover', expires: 0, inflight: 0, uncertain: false, initialized: false, retired: false, adapter, drain: new Set(), lane };
    this.entries.set(id, e);
    e.transition = this.initialize(e);
    await e.transition;
  }
  private async initialize(e: Entry) {
    try { await this.withAdapter(e, async () => { await e.adapter.revoke(); await e.adapter.reset(true); }); e.state = 'idle'; }
    catch { e.state = 'faulted'; e.uncertain = true; }
    finally { e.initialized = true; }
  }
  private withAdapter(e: Entry, action: () => Promise<void>) {
    // A late Kasm permission update must finish BEFORE recovery revokes it.
    // Reuse this lane across generations; do not hold it while draining RPCs.
    const result = e.lane.tail.then(async () => {
      if (e.retired) throw new ControlError('控制器已替换');
      await action();
    });
    e.lane.tail = result.catch(() => {});
    return result;
  }
  private get(id: string) {
    const e = this.entries.get(id);
    if (!e) throw new ControlError('控制服务尚未就绪', 503);
    return e;
  }
  private same(a?: Actor, b?: Actor) { return !!a && !!b && a.kind === b.kind && a.id === b.id; }
  status(id: string, actor?: Actor) {
    if (this.holds.has(id)) return { managed: true, state: 'maintenance', epoch: '', generation: this.entries.get(id)?.generation || 0,
      free: false, mine: false, holder: null, kind: null, expiresAt: 0, inflight: this.entries.get(id)?.inflight || 0, pending: true, reason: this.holds.get(id) };
    const e = this.get(id);
    if (e.owner && this.now() >= e.expires) this.begin(e, undefined, 'expired');
    return { managed: true, state: e.state, epoch: e.epoch, generation: e.generation,
      free: e.state === 'idle', mine: this.same(e.owner, actor), holder: e.owner?.label || null,
      kind: e.owner?.kind || null, expiresAt: e.expires, inflight: e.inflight, pending: e.state === 'handover' };
  }
  private begin(e: Entry, next?: Actor, reason = next ? 'taken-over' : 'interrupted') {
    const id = [...this.entries].find(([, value]) => value === e)?.[0];
    const previousEpoch = e.epoch;
    // Invalidate synchronously, before ANY await: no new old-epoch action enters.
    e.epoch = randomUUID(); e.owner = undefined; e.token = undefined; e.password = undefined;
    e.expires = 0; e.state = 'handover';
    try { if (id) this.observer.end?.(id, previousEpoch, reason); }
    catch { e.uncertain = true; } // A journal failure must never leave the old owner writable.
    e.transition = (async () => {
      try {
        await this.withAdapter(e, () => e.adapter.revoke());
        if (e.inflight) await new Promise<void>(resolve => e.drain.add(resolve));
        if (e.uncertain || e.retired) { e.state = 'faulted'; return; }
        await this.withAdapter(e, async () => {
          await e.adapter.reset(false);
          if (e.retired) return;
          if (next?.kind === 'agent') await e.adapter.grantAgent?.();
          if (next?.kind === 'human') {
            e.password = randomBytes(32).toString('hex');
            await e.adapter.grantHuman(e.password);
          }
        });
        if (e.retired) return;
        if (next && id) this.observer.grant?.(id, next, e.epoch, e.generation);
        e.owner = next; e.state = next?.kind || 'idle';
        e.token = next?.kind === 'agent' ? randomBytes(32).toString('hex') : undefined;
        e.expires = next ? this.now() + this.ttlMs : 0;
      } catch { e.state = 'faulted'; e.uncertain = true; e.owner = undefined; e.token = undefined; }
    })();
  }
  async take(id: string, actor: Actor, force = false): Promise<ReturnType<ControlLeases['status']> & { token?: string }> {
    this.assertNotHeld(id);
    const e = this.get(id); this.status(id);
    if (e.state === 'faulted') throw new ControlError('输入状态不确定，请管理员恢复控制服务');
    if (e.state === 'handover') return this.status(id, actor);
    if (this.same(e.owner, actor)) { e.expires = this.now() + this.ttlMs; return this.grant(id, actor); }
    if (e.owner && !force) throw new ControlError('桌面已有操作者，请等待其交回控制');
    if (force && actor.kind !== 'human') throw new ControlError('Agent 不能抢占人工控制');
    this.begin(e, actor);
    // Long in-flight actions keep handover pending; never claim premature success.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([e.transition, new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]);
    if (timer) clearTimeout(timer);
    return this.grant(id, actor);
  }
  private grant(id: string, actor: Actor) {
    const e = this.get(id); return { ...this.status(id, actor), ...(this.same(e.owner, actor) && e.token ? { token: e.token } : {}) };
  }
  renew(id: string, actor: Actor, epoch: string) {
    const e = this.check(id, actor, epoch); e.expires = this.now() + this.ttlMs; return this.status(id, actor);
  }
  async release(id: string, actor: Actor, epoch: string) {
    const e = this.check(id, actor, epoch); this.begin(e, undefined, 'released'); await e.transition; return this.status(id, actor);
  }
  private check(id: string, actor: Actor, epoch: string) {
    this.assertNotHeld(id); this.status(id); const e = this.get(id);
    if (!this.same(e.owner, actor) || epoch !== e.epoch || !['human', 'agent'].includes(e.state)) throw new ControlError('控制权已失效，请重新获取桌面状态');
    return e;
  }
  agent(id: string, token: string): { actor: Actor; epoch: string } {
    this.assertNotHeld(id); this.status(id); const e = this.get(id);
    if (!token || e.state !== 'agent' || e.token !== token || !e.owner) throw new ControlError('需要有效的 Agent 控制租约', 403);
    return { actor: e.owner, epoch: e.epoch };
  }
  humanPassword(id: string, actor: Actor, epoch: string) {
    const e = this.check(id, actor, epoch);
    if (actor.kind !== 'human' || !e.password) throw new ControlError('只读桌面');
    return e.password;
  }
  async write<T>(id: string, actor: Actor, epoch: string, action: (assertCurrent: () => void) => Promise<T>, name = 'desktop-input'): Promise<T> {
    const e = this.check(id, actor, epoch);
    if (e.inflight) throw new ControlError('上一操作尚未结束');
    const record = this.observer.action?.(id, actor, epoch, name);
    e.inflight++;
    try {
      const result = await action(() => { if (e.retired) throw new ControlError('原操作已中断，不能向新的桌面继续输入'); });
      if (record) this.observer.result?.(record, true);
      return result;
    }
    catch (error) {
      e.uncertain = true;
      if (record) { try { this.observer.result?.(record, false); } catch { /* retain the running record for restart reconciliation */ } }
      if (e.state !== 'handover') this.begin(e);
      throw error;
    } finally {
      e.inflight--;
      if (!e.inflight) { for (const done of e.drain) done(); e.drain.clear(); }
    }
  }
  async recover(id: string) {
    this.assertNotHeld(id);
    const old = this.get(id);
    const previousEpoch = old.epoch;
    old.retired = true; old.owner = undefined; old.token = undefined; old.epoch = randomUUID(); old.uncertain = true; old.state = 'faulted';
    this.observer.end?.(id, previousEpoch, 'administrator-recovery');
    // HTTP input may still be uploading a paste before spawning its helper.
    // Retain the old entry until that whole action completes; hard fencing
    // then waits for any helper whose Docker response was lost.
    if (old.inflight) await new Promise<void>(resolve => old.drain.add(resolve));
    // A fresh entry prevents late completions from mutating recovered ownership.
    // ensure() replaces the entry but retains its serialized adapter lane.
    await this.ensure(id, old.generation, old.adapter, true);
    return this.status(id);
  }
  private assertNotHeld(id: string) { if (this.holds.has(id)) throw new ControlError('实例维护中，暂停接受输入'); }
  busy(id: string) {
    if (this.holds.has(id)) return true;
    if (!this.entries.has(id)) return false;
    const state = this.status(id); return !state.free;
  }
  hold(id: string, reason: string) { this.holds.set(id, reason); }
  async suspend(id: string, reason: string, force = false) {
    this.hold(id, reason);
    const e = this.entries.get(id); if (!e) return;
    const previousEpoch = e.epoch;
    e.retired = true; e.owner = undefined; e.token = undefined; e.password = undefined; e.epoch = randomUUID(); e.state = 'faulted';
    this.observer.end?.(id, previousEpoch, reason);
    await e.lane.tail;
    // A broken Kasm server must not prevent a Docker stop/restart from fencing it.
    await e.adapter.revoke().catch(() => {});
    if (!force && e.inflight) {
      let timer: NodeJS.Timeout | undefined;
      try { await Promise.race([new Promise<void>(r => e.drain.add(r)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ControlError('旧操作尚未结束，维护保持锁定')), 40_000);
      })]); } finally { if (timer) clearTimeout(timer); }
    }
  }
  prepareResume(id: string) { this.entries.delete(id); }
  endMaintenance(id: string) { this.holds.delete(id); }
  ready(id: string) { return this.entries.get(id)?.state === 'idle'; }
  tick() { for (const id of this.entries.keys()) this.status(id); }
}
