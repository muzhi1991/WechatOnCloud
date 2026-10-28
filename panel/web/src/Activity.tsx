import { useEffect, useState } from 'react';
import { api, type InstanceActivity } from './api';
import { useUI } from './ui';
const names: Record<string, string> = { restart: '重启实例', 'create-or-upgrade': '创建或升级', upgradeInstance: '升级实例', stopInstance: '停止实例', start: '启动实例', backup: '创建备份', 'rollback-image': '回退镜像', 'restore-backup': '恢复备份', 'administrator-review': '核对维护结果', 'runtime-changed': '运行环境发生变化', 'watchdog-hard': '内存保护重启', 'watchdog-soft': '空闲时内存维护', 'quiesced-volume': '停机数据备份' };
const actionNames: Record<string, string> = { Keyboard: '键盘输入', Mouse: '鼠标操作', SetClipboard: '设置剪贴板', Open: '打开应用或文件', Close: '关闭窗口', type: '转发文字', key: '快捷键', paste: '粘贴', DriverCallTool: '桌面工具调用' };
const label = (record: { name: string; kind: string }) => names[record.name] || (record.kind === 'action' ? actionNames[record.name.split('/').pop() || ''] || '桌面操作' : record.name);
const states = { running: '进行中', done: '已完成', interrupted: '已中断', uncertain: '结果待核对' };
export function Activity({ id, admin, onVisibilityChange, onBusyChange }: { id: string; admin: boolean; onVisibilityChange?: (open: boolean) => void; onBusyChange?: (busy: boolean) => void }) {
  const [open, setOpen] = useState(false), [data, setData] = useState<InstanceActivity | null>(null), [busy, setBusy] = useState(false);
  const { toast, confirm } = useUI();
  const visibility = (value: boolean) => { setOpen(value); onVisibilityChange?.(value); };
  useEffect(() => () => { onVisibilityChange?.(false); onBusyChange?.(false); }, []);
  const refresh = () => api.activity(id).then(setData).catch(e => toast(e.message, 'error'));
  useEffect(() => { if (!open) return; void refresh(); const timer = setInterval(() => void refresh(), 3000); return () => clearInterval(timer); }, [open, id]);
  const act = async (operation: 'review' | 'backup' | 'rollback-image' | 'restore-backup', backup?: string) => {
    const title = { review: '核对后结束维护', backup: '创建停机备份', 'rollback-image': '回退实例镜像', 'restore-backup': '恢复备份数据' }[operation];
    const body = { review: '请先核对应用和文件状态。正在运行的实例会先重启，以终止可能遗留的安装进程；已停止的实例保持停止。不会重放 Agent 操作。', backup: '将交回控制并短暂停止应用，保存数据后恢复运行。', 'rollback-image': '将保存当前数据并重建容器。此操作只回退镜像，不回退应用数据。', 'restore-backup': '将先保存当前数据，再停止应用并覆盖备份中的同名文件；备份外的新文件会保留。失败时保持停止，请核对后处理。' }[operation];
    if (!await confirm({ title, body, confirmText: '继续', danger: operation === 'restore-backup' })) return;
    setBusy(true); onBusyChange?.(true);
    try { await api.maintenance(id, operation, backup); await refresh(); toast('操作已完成', 'ok'); }
    catch (e: any) { toast(e.message, 'error'); await refresh(); }
    finally { setBusy(false); onBusyChange?.(false); }
  };
  return <>
    <button className="ws-action" onClick={() => visibility(true)}>运行记录</button>
    {open && <div className="modal-mask" onClick={() => visibility(false)}><section className="card modal" role="dialog" aria-label="运行记录" onClick={e => e.stopPropagation()} style={{ maxWidth: 720, width: '95%', maxHeight: '85vh', overflowY: 'auto' }}>
      <h2>运行记录</h2>
      <p className="muted">中断后请先核对实际结果，再发起新任务。系统不会自动重放输入或发送操作。</p>
      {data?.maintenance && <p role="status">{data.maintenance.active ? '维护进行中' : '维护未完成，等待核对'}：{names[data.maintenance.name] || data.maintenance.name}</p>}
      <div className="modal-actions">
        {admin && <button className="btn" disabled={busy || !!data?.maintenance} onClick={() => void act('backup')}>创建备份</button>}
        {admin && data?.maintenance && !data.maintenance.active && <button className="btn" disabled={busy} onClick={() => void act('review')}>核对后结束维护</button>}
        <button className="btn" onClick={() => visibility(false)}>关闭</button>
      </div>
      <ul style={{ padding: 0, listStyle: 'none' }}>{data?.records.map(record => <li key={record.id} style={{ borderTop: '1px solid #ddd', padding: '12px 0' }}>
        <strong>{label(record)}</strong> · {states[record.state]}
        <div className="muted small">{new Date(record.at).toLocaleString()}{record.kind === 'action' && record.state === 'uncertain' ? ' · 操作可能已经生效，请核对画面' : ''}{record.reason === 'controller-restarted' ? ' · 面板重启导致中断' : ''}</div>
        {admin && record.kind === 'backup' && record.state === 'done' && <div className="modal-actions">
          <button className="btn" disabled={busy || data.maintenance?.active || record.details?.lifecycleCompatible === false} onClick={() => void act('rollback-image', record.id)}>回退到此镜像</button>
          <button className="btn" disabled={busy || data.maintenance?.active} onClick={() => void act('restore-backup', record.id)}>恢复此备份</button>
        </div>}
      </li>)}</ul>
      {data && !data.records.length && <p className="muted">暂无记录</p>}
    </section></div>}
  </>;
}
