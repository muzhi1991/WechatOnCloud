import { useEffect, useState } from 'react';
import { useAuth } from '../auth';

export default function Agent({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { user } = useAuth();
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/agent', { signal: controller.signal }).then(async r => {
      const result = await r.json();
      if (!r.ok) throw new Error(result.error || 'AI 助手暂时不可用');
      setEndpoint(result.url);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, []);
  if (user?.role !== 'admin') return <div className="empty">AI 助手当前仅供管理员使用。</div>;
  return <section style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
    <header className="ws-head">
      <button className="ws-menu" onClick={onOpenMenu} aria-label="打开导航">☰</button>
      <span className="ws-title">AI 助手</span><span style={{ color: 'var(--muted)', flex: 1, fontSize: 12 }}>对话与文件</span>
      <button className="btn-text" onClick={() => setRevision(value => value + 1)}>重新连接</button>
      {endpoint && <a className="btn-text" style={{ textDecoration: 'none' }} href={endpoint} target="_blank" rel="noreferrer">独立打开</a>}
    </header>
    {error && <p role="alert" style={{ padding: 24 }}>{error}</p>}
    {!endpoint && !error && <div className="center-screen"><div className="spinner" /></div>}
    {endpoint && <iframe key={revision} title="WOC AI 助手" src={endpoint} style={{ border: 0, width: '100%', flex: 1, minHeight: 0 }} allow="clipboard-read; clipboard-write" />}
  </section>;
}
