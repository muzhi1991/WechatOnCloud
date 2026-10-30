import { useEffect, useRef, useState } from "react";
export const WECHAT_CHECK_SCRIPT = "/opt/woc/services/woc-trigger/examples/wechat-check.py";
export const wechatDefaults = (machine: string) => [
  WECHAT_CHECK_SCRIPT,
  "--machine",
  machine,
  "--chat",
  "",
  "--agent",
  "",
  "--instruction",
  "汇总新消息，不发送回复",
];
const argument = (args: string[], flag: string) => {
  const i = args.indexOf(flag);
  return i < 0 ? "" : args[i + 1] || "";
};
const replaceArgument = (args: string[], flag: string, value: string) => {
  const next = [...args],
    i = next.indexOf(flag);
  if (i < 0) next.push(flag, value);
  else next.splice(i + 1, 1, value);
  return next;
};
export function validateWechatArguments(args: unknown) {
  if (!Array.isArray(args) || args[0] !== WECHAT_CHECK_SCRIPT) return;
  if (!args.every((value) => typeof value === "string")) throw Error("脚本参数必须是字符串数组。");
  for (const [flag, label] of [
    ["--machine", "电脑"],
    ["--chat", "对话"],
    ["--agent", "目标 Agent 会话"],
    ["--instruction", "任务说明"],
  ]) {
    if (!argument(args, flag).trim()) throw Error(`请在脚本参数中填写${label}，也可展开辅助填写。`);
  }
  if (argument(args, "--chat").endsWith("@chatroom") && !argument(args, "--sender").trim())
    throw Error("请填写关注的群成员 username。");
}
type Chat = { username: string; chat?: string; display?: string };
export default function WechatArguments({
  machines,
  agents,
  args: raw,
  onChange,
  onMachineChange,
}: {
  machines: { id: string; name: string }[];
  agents: { id: string; title: string; archived: boolean }[];
  args: string;
  onChange: (args: string) => void;
  onMachineChange: (oldMachine: string, machine: string) => void;
}) {
  let args: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) args = parsed;
  } catch {
    /* Raw editor owns JSON validation. */
  }
  const machine = argument(args, "--machine"),
    chat = argument(args, "--chat"),
    agent = argument(args, "--agent");
  const [kind, setKind] = useState("sessions"),
    [query, setQuery] = useState(""),
    [chats, setChats] = useState<Chat[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    request.current?.abort();
    setChats([]);
    setBusy(false);
    setError("");
    return () => request.current?.abort();
  }, [machine, kind]);
  if (args[0] !== WECHAT_CHECK_SCRIPT) return null;
  const set = (flag: string, value: string) =>
    onChange(JSON.stringify(replaceArgument(args, flag, value), null, 2));
  const search = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    setChats([]);
    try {
      const r = await fetch(`/api/integrations/wechat/${encodeURIComponent(machine)}/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ limit: 100, ...(kind === "sessions" ? {} : { query }) }),
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error || "读取失败");
      if (!controller.signal.aborted) setChats(Array.isArray(data) ? data : data[kind] || []);
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <details className="auto-argument-helper">
      <summary>查找并填写微信参数（可选）</summary>
      <div className="auto-editor-form">
        <small className="muted">这里的选择会直接填入上方脚本参数，也可以直接编辑 JSON。</small>
        <label>
          电脑
          <select
            aria-label="微信电脑"
            value={machine}
            onChange={(e) => {
              let next = replaceArgument(args, "--machine", e.target.value);
              next = replaceArgument(replaceArgument(next, "--chat", ""), "--sender", "");
              onChange(JSON.stringify(next, null, 2));
              onMachineChange(machine, e.target.value);
            }}
          >
            <option value="">选择运行微信的电脑</option>
            {machine && !machines.some((m) => m.id === machine) && (
              <option value={machine}>{machine}</option>
            )}
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          查找对话
          <select aria-label="查找对话" value={kind} onChange={(e) => setKind(e.target.value)}>
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
          <select
            aria-label="微信对话"
            value={chat}
            onChange={(e) => set("--chat", e.target.value)}
          >
            <option value="">选择对话</option>
            {chat && !chats.some((c) => c.username === chat) && (
              <option value={chat}>{chat}</option>
            )}
            {chats.map((c) => (
              <option key={c.username} value={c.username}>
                {c.chat || c.display || c.username} · {c.username}
              </option>
            ))}
          </select>
        </label>
        {chat.endsWith("@chatroom") && (
          <label>
            关注的群成员（准确的微信 username）
            <input
              value={argument(args, "--sender")}
              onChange={(e) => set("--sender", e.target.value)}
            />
          </label>
        )}
        <label>
          目标 Agent 会话
          <select
            aria-label="目标 Agent 会话"
            value={agent}
            onChange={(e) => set("--agent", e.target.value)}
          >
            <option value="">选择会话</option>
            {agent && !agents.some((a) => a.id === agent && !a.archived) && (
              <option value={agent}>{agent}</option>
            )}
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
            rows={3}
            value={argument(args, "--instruction")}
            onChange={(e) => set("--instruction", e.target.value)}
          />
        </label>
      </div>
    </details>
  );
}
