import { useEffect, useState } from 'react';
import { api, type ControlTimeouts } from '../api';
import { useUI } from '../ui';

const fields = [
  { key: 'disconnectSeconds', label: '网页断线超时（秒）', min: 15, max: 300, help: '默认 30 秒。服务端未收到任何持有者页面心跳时交回；浏览器关闭、断网或冻结后台页面都可能触发。' },
  { key: 'humanIdleSeconds', label: '网页操作空闲超时（秒）', min: 30, max: 3600, help: '默认 300 秒（5 分钟）。桌面无键盘、鼠标、滚轮、触摸或输入条操作时交回；自动心跳和查询不计入活动。' },
  { key: 'agentIdleSeconds', label: 'Agent 操作空闲超时（秒）', min: 1, max: 3600, help: '默认 120 秒。没有 GUI 写操作时交回；截图和查询不续期，执行中的操作会等待结束。' },
] as const;

export function ControlTimeoutSettings({ isAdmin }: { isAdmin: boolean }) {
  const [value, setValue] = useState<ControlTimeouts>();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const { toast } = useUI();
  useEffect(() => { api.controlTimeouts().then(setValue).catch(e => setError(e.message)); }, []);
  return <section className="settings-block" aria-label="控制权超时">
    <div className="section-row"><span className="section-title">控制权超时</span></div>
    <p className="muted small">所有受管实例共用，由管理员修改。保存后立即生效；已超过新时限的控制权会交回，桌面自动转为只读。重新操作需要再次申请控制。</p>
    {error && <p role="alert">{error}</p>}
    {value && <form onSubmit={async e => {
      e.preventDefault(); setSaving(true); setError('');
      try { setValue(await api.setControlTimeouts(value)); toast('控制权超时设置已保存', 'ok'); }
      catch (e: any) { setError(e.message); } finally { setSaving(false); }
    }}>
      {fields.map(field => <div key={field.key} style={{ marginBottom: 18 }}>
        <label>{field.label}<input className="input" type="number" min={field.min} max={field.max} step="1" required
          disabled={!isAdmin || saving} value={value[field.key]} style={{ display: 'block', width: 160, marginTop: 6 }}
          onChange={e => setValue({ ...value, [field.key]: e.target.valueAsNumber })} /></label>
        <p className="muted small">{field.help}</p>
      </div>)}
      {isAdmin && <button className="btn btn-primary" disabled={saving}>{saving ? '保存中…' : '保存超时设置'}</button>}
    </form>}
  </section>;
}
