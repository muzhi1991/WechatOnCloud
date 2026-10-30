import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../auth";
import AgentFrame from "../AgentFrame";
export default function Agent({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const [revision, setRevision] = useState(0);
  const [endpoint, setEndpoint] = useState("");
  if (user?.role !== "admin") return <div className="empty">AI 助手当前仅供管理员使用。</div>;
  return (
    <section className="agent-page">
      <header className="ws-head">
        <button className="ws-menu" onClick={onOpenMenu} aria-label="打开导航">
          ☰
        </button>
        <span className="ws-title">AI 助手</span>
        <span className="agent-spacer" />
        <button className="btn-text" onClick={() => setRevision((n) => n + 1)}>
          重新连接
        </button>
        {endpoint && (
          <a className="btn-text" href={endpoint} target="_blank" rel="noreferrer">
            独立打开
          </a>
        )}
      </header>
      <AgentFrame
        onReady={setEndpoint}
        key={revision + params.toString()}
        machineId={params.get("machine") || undefined}
        agentId={params.get("conversation") || undefined}
      />
    </section>
  );
}
