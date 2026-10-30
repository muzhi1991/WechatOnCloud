import { useState } from 'react';
import { api, type ControlStatus } from './api';
import { useUI } from './ui';

// Passive status stays in the header; confirmation opens only after a user action.
export function ControlStrip({ id, status, admin, onChange }: {
  id: string; status: ControlStatus | null; admin: boolean; onChange(value: ControlStatus): void;
}) {
  const [busy, setBusy] = useState(false);
  const { toast, confirm } = useUI();
  const run = async (action: () => Promise<ControlStatus>) => {
    setBusy(true);
    try { onChange(await action()); }
    catch (e: any) { toast(e.message || '控制操作失败', 'error'); }
    finally { setBusy(false); }
  };
  const take = async () => {
    setBusy(true);
    try {
      const current = await api.controlStatus(id);
      onChange(current);
      if (current.kind === 'agent' && !current.mine) {
        if (!current.epoch) throw new Error('控制状态不完整，请刷新后再试');
        const accepted = await confirm({ title: '接管 Agent 的控制权？',
          body: `${current.holder || 'Agent'} 正在操作。接管后，该 Agent 将停止后续操作，等待已开始的操作结束后由你控制。是否接管？`,
          confirmText: '接管', cancelText: '取消' });
        if (!accepted) return;
        onChange(await api.controlTake(id, current.epoch));
      } else onChange(await api.controlTake(id));
    } catch (e: any) {
      toast(e.message || '控制操作失败', 'error');
      try { onChange(await api.controlStatus(id)); } catch { /* Keep last observed state. */ }
    } finally { setBusy(false); }
  };
  const request = status?.request;
  const blocked = !status || status.pending || status.state === 'faulted';
  const label = !status ? '正在确认控制权…' : status.state === 'maintenance' ? '维护中 · 只读'
    : status.state === 'handover' ? '正在交接 · 只读' : status.state === 'faulted' ? '控制状态待恢复 · 只读'
    : status.mine ? '你正在控制' : status.holder ? `只读 · ${status.holder}正在控制` : '只读 · 暂无操作者';
  return <section className="control-strip" aria-label="桌面控制权">
    <span className={'control-status' + (status?.mine ? ' is-owner' : '')} role="status" title={label}>{label}</span>
    {status?.mine
      ? <button className="ws-action" disabled={busy} onClick={() => void run(() => api.controlRelease(id))}>交回控制</button>
      : request?.mine
        ? <><span className="control-hint">已申请，等待同意</span><button className="ws-action" disabled={busy} onClick={() => void run(() => api.controlCancel(id, request.id))}>取消申请</button></>
        : <button className="ws-action" disabled={busy || blocked || !!request} onClick={() => void take()}>申请控制</button>}
    {request?.canRespond && <div className="control-request" role="status">
      <span>{request.label}申请控制 · 60 秒内有效</span>
      <button className="ws-action" disabled={busy} onClick={() => void run(() => api.controlRespond(id, request.id, true))}>同意</button>
      <button className="ws-action" disabled={busy} onClick={() => void run(() => api.controlRespond(id, request.id, false))}>拒绝</button>
    </div>}
    {request && !request.mine && !request.canRespond && <span className="control-hint">已有待处理申请</span>}
    {admin && status?.holder && status.kind !== 'agent' && !status.mine && !blocked && <button className="ws-action control-force" disabled={busy} onClick={async () => {
      if (await confirm({ title: '管理员强制接管？', body: '将结束当前操作者的控制权。普通申请需要持有人同意。', danger: true, confirmText: '强制接管' }))
        void run(() => api.controlForce(id));
    }}>强制接管</button>}
    {admin && status?.state === 'faulted' && <button className="ws-action" disabled={busy} onClick={() => void run(() => api.controlRecover(id))}>恢复控制服务</button>}
  </section>;
}
