import { useState } from "react";
import { useNavigate } from "react-router-dom";
import AgentFrame from "./AgentFrame";
export default function AgentDrawer({
  machineId,
  name,
  onClose,
}: {
  machineId: string;
  name: string;
  onClose: () => void;
}) {
  const [agentId, setAgentId] = useState("");
  const navigate = useNavigate();
  const expand = () =>
    navigate(
      "/agent?" +
        new URLSearchParams({ machine: machineId, ...(agentId ? { conversation: agentId } : {}) }),
    );
  return (
    <aside className="agent-drawer" aria-label="电脑 AI 助手">
      <header className="ws-head">
        <strong className="ws-title">{name} · AI</strong>
        <button className="btn-text" onClick={expand}>
          展开
        </button>
        <button className="ws-action" aria-label="关闭 AI 助手" onClick={onClose}>
          ×
        </button>
      </header>
      <AgentFrame machineId={machineId} onAgent={setAgentId} />
    </aside>
  );
}
