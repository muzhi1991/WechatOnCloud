import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useUI } from "../ui";
import { useAuth } from "../auth";
import { useInstances } from "../AppShell";
import "./automation.css";
import WechatArguments, { wechatDefaults, validateWechatArguments } from "./WechatArguments";
type Trigger = {
  id?: string;
  name: string;
  enabled: boolean;
  source: {
    type: string;
    connection?: string;
    uri?: string;
    seconds?: number;
    expression?: string;
    timezone?: string;
  };
  action: {
    type: string;
    command?: string;
    args?: string[];
    cwd?: string;
    agent_id?: string;
    message?: string;
    include_input?: boolean;
    timeout_seconds: number;
  };
  next_run?: number;
  webhook_secret?: string;
};
type Run = {
  id: string;
  trigger_id: string | null;
  name: string;
  status: string;
  created: number;
  started?: number;
  ended?: number;
  log?: string;
  result?: { delivery?: string; agent_id?: string; completion?: string };
};
type Agent = { id: string; title: string; status: string; archived: boolean };
const request = async <T,>(path: string, method = "GET", body?: unknown): Promise<T> => {
  const r = await fetch("/api/automation/" + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const v = await r.json();
  if (!r.ok) throw Error(v.error || "请求失败");
  return v;
};
const fresh = (): Trigger => ({
  name: "",
  enabled: false,
  source: { type: "interval", seconds: 60 },
  action: {
    type: "script",
    command: "python3",
    args: [],
    cwd: "/workspace/woc",
    timeout_seconds: 300,
  },
});
const time = (n?: number) => (n ? new Date(n).toLocaleString() : "—");
const status: Record<string, string> = {
  queued: "待执行",
  waiting: "等待 Agent",
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  unknown: "结果待核对",
  interrupted: "已中断",
  canceled: "已取消",
};
export default function Automation({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { user } = useAuth(),
    { toast, confirm } = useUI(),
    { instances } = useInstances(),
    [params] = useSearchParams();
  const [triggers, setTriggers] = useState<Trigger[]>([]),
    [runs, setRuns] = useState<Run[]>([]),
    [agents, setAgents] = useState<Agent[]>([]),
    [connections, setConnections] = useState<string[]>([]);
  const [draft, setDraft] = useState<Trigger | null>(null),
    [args, setArgs] = useState("[]"),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [secret, setSecret] = useState<{ id: string; value: string } | null>(null),
    [detail, setDetail] = useState<Run | null>(null),
    [filter, setFilter] = useState("");
  const [template, setTemplate] = useState("");
  const [sourceHealth, setSourceHealth] = useState<
    { source: string[]; connected: boolean; error: string | null }[]
  >([]);
  const refresh = useCallback(async () => {
    try {
      const [a, b, h] = await Promise.all([
        request<{ triggers: Trigger[] }>("triggers"),
        request<{ runs: Run[] }>("runs"),
        request<{ sources: typeof sourceHealth }>("health"),
      ]);
      setTriggers(a.triggers);
      setRuns(b.runs);
      setSourceHealth(h.sources);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (user?.role !== "admin") return;
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    void request<{ agents: Agent[] }>("agents")
      .then((r) => setAgents(r.agents))
      .catch((e) => setError(e.message));
    void request<{ connections: string[] }>("catalog")
      .then((r) => setConnections(r.connections))
      .catch((e) => setError(e.message));
    return () => clearInterval(t);
  }, [refresh, user?.role]);
  const edit = (t: Trigger) => {
    setTemplate("");
    setDraft(structuredClone(t));
    setArgs(JSON.stringify(t.action.args || [], null, 2));
  };
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const next = {
        ...draft,
        action: {
          ...draft.action,
          ...(draft.action.type === "script" ? { args: JSON.parse(args) } : {}),
        },
      };
      if (next.action.type === "script") validateWechatArguments(next.action.args);
      const t = await request<Trigger>(
        "triggers" + (draft.id ? "/" + draft.id : ""),
        draft.id ? "PUT" : "POST",
        next,
      );
      if (t.webhook_secret) setSecret({ id: t.id!, value: t.webhook_secret });
      setDraft(null);
      await refresh();
      toast("已保存");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };
  const toggle = async (t: Trigger) => {
    try {
      await request("triggers/" + t.id, "PUT", { ...t, enabled: !t.enabled });
      await refresh();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const remove = async (t: Trigger) => {
    if (!(await confirm({ title: "删除自动化", body: t.name, confirmText: "删除", danger: true })))
      return;
    try {
      await request("triggers/" + t.id, "DELETE");
      await refresh();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const test = async (t: Trigger) => {
    if (
      !(await confirm({ title: "测试运行", body: "会真实执行已配置的动作。", confirmText: "运行" }))
    )
      return;
    try {
      await request("triggers/" + t.id + "/run", "POST", {});
      await refresh();
      toast("已加入执行队列");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const preset = (value: string) => {
    setTemplate(value);
    if (value !== "wechat" || !draft) return;
    const machine = params.get("machine") || "";
    const defaults = fresh();
    setDraft({
      ...draft,
      name: draft.name || "微信消息检查",
      source: { type: "mcp", connection: "woc", uri: `wechat://${machine}/messages` },
      action: defaults.action,
    });
    setArgs(JSON.stringify(wechatDefaults(machine), null, 2));
  };
  if (user?.role !== "admin") return <div className="empty">自动化当前仅供管理员使用。</div>;
  return (
    <section className="automation-page">
      <header className="ws-head">
        <button className="ws-menu" onClick={onOpenMenu}>
          ☰
        </button>
        <span className="ws-title">自动化</span>
        <span className="agent-spacer" />
        <button className="btn btn-primary" onClick={() => edit(fresh())}>
          新建
        </button>
      </header>
      <main className="automation-main">
        {error && (
          <p role="alert" className="auto-error">
            {error}
          </p>
        )}
        {sourceHealth
          .filter((s) => s.error)
          .map((s) => (
            <p className="auto-error" key={s.source.join(":")}>
              订阅 {s.source[1]}：{s.error}
            </p>
          ))}
        {!triggers.length && !error && (
          <div className="auto-empty">还没有自动化。选择一个触发条件，再配置要执行的动作。</div>
        )}
        <div className="auto-list">
          {triggers.map((t) => (
            <article className="auto-row" key={t.id}>
              <div>
                <strong>{t.name}</strong>
                <p className="muted">
                  {t.source.type === "mcp"
                    ? "资源更新"
                    : t.source.type === "webhook"
                      ? "Webhook"
                      : t.source.type === "interval"
                        ? `每 ${t.source.seconds} 秒`
                        : t.source.expression}{" "}
                  · {t.action.type === "agent" ? "Agent 任务" : "脚本"}
                  {t.next_run ? ` · 下次 ${time(t.next_run)}` : ""}
                </p>
              </div>
              <label className="auto-toggle">
                <input type="checkbox" checked={t.enabled} onChange={() => void toggle(t)} />
                启用
              </label>
              <details className="auto-menu">
                <summary aria-label={`${t.name}操作`}>⋮</summary>
                <div>
                  <button onClick={() => edit(t)}>编辑</button>
                  <button onClick={() => void test(t)}>测试运行</button>
                  <button onClick={() => setFilter(t.id!)}>运行记录</button>
                  <button onClick={() => void remove(t)}>删除</button>
                </div>
              </details>
            </article>
          ))}
        </div>
        <div className="auto-section-title">
          <h3>运行记录</h3>
          {filter && (
            <button className="btn-text" onClick={() => setFilter("")}>
              显示全部
            </button>
          )}
        </div>
        <div className="auto-list">
          {runs
            .filter((r) => !filter || r.trigger_id === filter)
            .map((r) => (
              <button
                className="auto-run"
                key={r.id}
                onClick={() =>
                  void request<Run>("runs/" + r.id)
                    .then(setDetail)
                    .catch((e) => toast(e.message, "error"))
                }
              >
                <span>
                  {r.name}
                  <small>{time(r.created)}</small>
                </span>
                <span>
                  {r.result?.delivery === "accepted" && r.status === "succeeded"
                    ? "Agent 已接收 · 已空闲"
                    : status[r.status] || r.status}
                </span>
              </button>
            ))}
        </div>
      </main>
      {draft && (
        <div className="modal-mask">
          <div
            className="card modal auto-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="automation-editor-title"
          >
            <h2 id="automation-editor-title">{draft.id ? "编辑自动化" : "新建自动化"}</h2>
            {!draft.id && (
              <label>
                套用预置模板（可选）
                <select
                  aria-label="预置模板"
                  value={template}
                  onChange={(e) => preset(e.target.value)}
                >
                  <option value="">自定义配置</option>
                  <option value="wechat">微信消息检查</option>
                </select>
              </label>
            )}
            <form
              className="auto-editor-form"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <label>
                名称
                <input
                  required
                  value={draft.name}
                  maxLength={120}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <fieldset>
                <legend>什么时候触发</legend>
                <select
                  aria-label="触发条件"
                  value={draft.source.type}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      source:
                        e.target.value === "mcp"
                          ? { type: "mcp", connection: connections[0] || "", uri: "" }
                          : e.target.value === "cron"
                            ? { type: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" }
                            : e.target.value === "interval"
                              ? { type: "interval", seconds: 60 }
                              : { type: "webhook" },
                    })
                  }
                >
                  <option value="interval">每隔一段时间</option>
                  <option value="cron">每天 / Cron 定时</option>
                  <option value="mcp">MCP 资源更新</option>
                  <option value="webhook">Webhook 通知</option>
                </select>
                {draft.source.type === "interval" && (
                  <label>
                    间隔（秒）
                    <input
                      type="number"
                      min={5}
                      max={31536000}
                      required
                      value={draft.source.seconds}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          source: { ...draft.source, seconds: Number(e.target.value) },
                        })
                      }
                    />
                  </label>
                )}
                {draft.source.type === "cron" && (
                  <>
                    <label>
                      每天的时间
                      <input
                        type="time"
                        onChange={(e) => {
                          const [h, m] = e.target.value.split(":").map(Number);
                          if (Number.isFinite(h) && Number.isFinite(m))
                            setDraft({
                              ...draft,
                              source: { ...draft.source, expression: `${m} ${h} * * *` },
                            });
                        }}
                      />
                    </label>
                    <label>
                      Cron（分 时 日 月 周）
                      <input
                        required
                        value={draft.source.expression}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            source: { ...draft.source, expression: e.target.value },
                          })
                        }
                      />
                    </label>
                    <label>
                      时区
                      <input
                        required
                        value={draft.source.timezone}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            source: { ...draft.source, timezone: e.target.value },
                          })
                        }
                      />
                    </label>
                  </>
                )}
                {draft.source.type === "mcp" && (
                  <>
                    <label>
                      连接
                      <select
                        value={draft.source.connection}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            source: { ...draft.source, connection: e.target.value },
                          })
                        }
                      >
                        {connections.map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      资源 URI
                      <input
                        required
                        value={draft.source.uri}
                        placeholder="wechat://电脑ID/messages"
                        onChange={(e) =>
                          setDraft({ ...draft, source: { ...draft.source, uri: e.target.value } })
                        }
                      />
                    </label>
                  </>
                )}
                {draft.source.type === "webhook" && (
                  <p className="muted">保存后提供接收地址和独立密钥。每次请求分别执行。</p>
                )}
              </fieldset>
              <fieldset>
                <legend>执行什么</legend>
                <select
                  aria-label="执行动作"
                  value={draft.action.type}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      action:
                        e.target.value === "agent"
                          ? {
                              type: "agent",
                              agent_id: "",
                              message: "",
                              include_input: true,
                              timeout_seconds: 1800,
                            }
                          : {
                              type: "script",
                              command: "python3",
                              args: [],
                              cwd: "/workspace/woc",
                              timeout_seconds: 300,
                            },
                    })
                  }
                >
                  <option value="script">运行脚本</option>
                  <option value="agent">给 Agent 发送任务</option>
                </select>
                {draft.action.type === "script" ? (
                  <>
                    <label>
                      程序
                      <input
                        required
                        value={draft.action.command}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            action: { ...draft.action, command: e.target.value },
                          })
                        }
                      />
                    </label>
                    <label>
                      参数（JSON 数组）
                      <textarea
                        required
                        rows={4}
                        value={args}
                        onChange={(e) => setArgs(e.target.value)}
                      />
                    </label>
                    <WechatArguments
                      machines={instances}
                      agents={agents}
                      args={args}
                      onChange={setArgs}
                      onMachineChange={(oldMachine, machine) => {
                        if (
                          draft.source.type === "mcp" &&
                          draft.source.uri === `wechat://${oldMachine}/messages`
                        )
                          setDraft({
                            ...draft,
                            source: { ...draft.source, uri: `wechat://${machine}/messages` },
                          });
                      }}
                    />
                    <label>
                      工作目录
                      <input
                        required
                        value={draft.action.cwd}
                        onChange={(e) =>
                          setDraft({ ...draft, action: { ...draft.action, cwd: e.target.value } })
                        }
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label>
                      目标会话
                      <select
                        required
                        value={draft.action.agent_id}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            action: { ...draft.action, agent_id: e.target.value },
                          })
                        }
                      >
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
                      任务内容
                      <textarea
                        required
                        rows={4}
                        value={draft.action.message}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            action: { ...draft.action, message: e.target.value },
                          })
                        }
                      />
                    </label>
                    <label className="auto-toggle">
                      <input
                        type="checkbox"
                        checked={draft.action.include_input !== false}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            action: { ...draft.action, include_input: e.target.checked },
                          })
                        }
                      />
                      附带触发输入
                    </label>
                    <p className="muted">等待会话空闲后提交。建议使用独立的自动化会话。</p>
                  </>
                )}
                <label>
                  执行超时（秒）
                  <input
                    required
                    type="number"
                    min={1}
                    max={3600}
                    value={draft.action.timeout_seconds}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        action: { ...draft.action, timeout_seconds: Number(e.target.value) },
                      })
                    }
                  />
                </label>
              </fieldset>
              <label className="auto-toggle">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                />
                保存后启用
              </label>
              <div className="modal-actions">
                <button className="btn" type="button" onClick={() => setDraft(null)}>
                  取消
                </button>
                <button className="btn btn-primary" disabled={saving}>
                  {saving ? "保存中…" : "保存"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {secret && (
        <div className="modal-mask">
          <div className="card modal auto-editor">
            <h2>Webhook 已创建</h2>
            <p>请保存密钥，只在这里显示一次。请求使用 Authorization: Bearer 密钥。</p>
            <label>
              接收地址
              <input readOnly value={location.origin + "/api/automation/hooks/" + secret.id} />
            </label>
            <label>
              密钥
              <input readOnly value={secret.value} />
            </label>
            <button className="btn" onClick={() => setSecret(null)}>
              已保存
            </button>
          </div>
        </div>
      )}
      {detail && (
        <div className="modal-mask">
          <div className="card modal auto-editor">
            <h2>{detail.name}</h2>
            <p>
              {status[detail.status]} · {time(detail.created)}
            </p>
            {detail.result?.agent_id && (
              <a href={"/agent?conversation=" + detail.result.agent_id}>打开 Agent 会话</a>
            )}
            <pre className="auto-log">{detail.log || "无输出"}</pre>
            {detail.result && (
              <pre className="auto-log">{JSON.stringify(detail.result, null, 2)}</pre>
            )}
            <button className="btn" onClick={() => setDetail(null)}>
              关闭
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
