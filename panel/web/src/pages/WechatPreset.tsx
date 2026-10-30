import { useState } from "react";
type Chat = { username: string; chat?: string; display?: string; is_group?: boolean };
export default function WechatPreset({
  machines,
  agents,
  initialMachine,
  onClose,
  onCreate,
}: {
  machines: { id: string; name: string }[];
  agents: { id: string; title: string; archived: boolean }[];
  initialMachine: string;
  onClose: () => void;
  onCreate: (input: {
    machine: string;
    chat: string;
    agent: string;
    sender: string;
    instruction: string;
  }) => void;
}) {
  const [machine, setMachine] = useState(initialMachine),
    [kind, setKind] = useState("sessions"),
    [query, setQuery] = useState(""),
    [chats, setChats] = useState<Chat[]>([]),
    [chat, setChat] = useState(""),
    [agent, setAgent] = useState(""),
    [sender, setSender] = useState(""),
    [instruction, setInstruction] = useState("汇总新消息，不发送回复"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const search = async () => {
    setBusy(true);
    setError("");
    setChats([]);
    setChat("");
    try {
      const r = await fetch(`/api/integrations/wechat/${encodeURIComponent(machine)}/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 100, ...(kind === "sessions" ? {} : { query }) }),
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error || "读取失败");
      setChats(Array.isArray(data) ? data : data[kind] || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const group = chat.endsWith("@chatroom");
  return (
    <form
      className="auto-editor-form"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate({ machine, chat, agent, sender, instruction });
      }}
    >
      <label>
        电脑
        <select
          required
          value={machine}
          onChange={(e) => {
            setMachine(e.target.value);
            setChats([]);
            setChat("");
          }}
        >
          <option value="">选择运行微信的电脑</option>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        查找对话
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setChats([]);
            setChat("");
          }}
        >
          <option value="sessions">最近会话</option>
          <option value="contacts">联系人</option>
          <option value="groups">群聊</option>
        </select>
      </label>
      {kind !== "sessions" && (
        <label>
          名称或微信 ID
          <input value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      )}
      <button
        type="button"
        className="btn"
        disabled={!machine || busy}
        onClick={() => void search()}
      >
        {busy ? "读取中…" : "查找"}
      </button>
      {error && (
        <p role="alert" className="auto-error">
          {error}
        </p>
      )}
      <label>
        对话
        <select required value={chat} onChange={(e) => setChat(e.target.value)}>
          <option value="">选择对话</option>
          {chats.map((c) => (
            <option key={c.username} value={c.username}>
              {c.chat || c.display || c.username} · {c.username}
            </option>
          ))}
        </select>
      </label>
      {group && (
        <label>
          关注的群成员（准确的微信 username）
          <input required value={sender} onChange={(e) => setSender(e.target.value)} />
          <small>仅处理这个成员的新消息，避免自动回复自身造成循环。</small>
        </label>
      )}
      <label>
        目标 Agent 会话
        <select required value={agent} onChange={(e) => setAgent(e.target.value)}>
          <option value="">选择会话</option>
          {agents
            .filter((a) => !a.archived)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
        </select>
      </label>
      <label>
        收到新消息后做什么
        <textarea
          required
          rows={3}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
      </label>
      <p className="muted">
        首次运行只记录当前消息。后续资源更新时检查最近 50 条、去重，再把新消息交给
        Agent。默认先保存为停用，测试后可启用。
      </p>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
        <button className="btn btn-primary" disabled={busy}>
          套用模板
        </button>
      </div>
    </form>
  );
}
