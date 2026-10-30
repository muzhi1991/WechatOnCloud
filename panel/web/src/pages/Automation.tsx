import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useUI } from "../ui";
import { useAuth } from "../auth";
import "./automation.css";
import AutomationEditor from "./AutomationEditor";
import { request, newStep, type Trigger, type Agent, type Catalog } from "./automation-model";
type Run = {
  id: string;
  trigger_id: string | null;
  name: string;
  status: string;
  created: number;
  started?: number;
  ended?: number;
  log?: string;
  result?: {
    delivery?: string;
    agent_id?: string;
    completion?: string;
    steps?: {
      id: string;
      status: string;
      error?: string;
      agent_id?: string;
      output?: { text: string; json: unknown };
      stderr?: string;
    }[];
  };
};
const fresh = (): Trigger => ({
  name: "",
  enabled: false,
  source: { type: "interval", seconds: 60 },
  steps: [newStep()],
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
    [params] = useSearchParams();
  const [triggers, setTriggers] = useState<Trigger[]>([]),
    [runs, setRuns] = useState<Run[]>([]),
    [agents, setAgents] = useState<Agent[]>([]),
    [catalog, setCatalog] = useState<Catalog>({
      connections: [],
      scripts: [],
      script_dir: "",
      workspace: "/workspace/woc",
    });
  const [draft, setDraft] = useState<Trigger | null>(null),
    [error, setError] = useState(""),
    [secret, setSecret] = useState<{ id: string; value: string } | null>(null),
    [detail, setDetail] = useState<Run | null>(null),
    [filter, setFilter] = useState("");
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
    void request<Catalog>("catalog")
      .then(setCatalog)
      .catch((e) => setError(e.message));
    return () => clearInterval(t);
  }, [refresh, user?.role]);
  const edit = (t: Trigger) => {
    setDraft(structuredClone(t));
    void request<Catalog>("catalog")
      .then(setCatalog)
      .catch((e) => toast(e.message, "error"));
  };
  const save = async (next: Trigger) => {
    await request("validate", "POST", next);
    const t = await request<Trigger>(
      "triggers" + (next.id ? "/" + next.id : ""),
      next.id ? "PUT" : "POST",
      next,
    );
    if (t.webhook_secret) setSecret({ id: t.id!, value: t.webhook_secret });
    setDraft(null);
    await refresh();
    toast("已保存");
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
  if (user?.role !== "admin") return <div className="empty">自动化当前仅供管理员使用。</div>;
  return (
    <section className="automation-page">
      <header className="ws-head">
        <button className="ws-menu" onClick={onOpenMenu}>
          ☰
        </button>
        <span className="ws-title">自动化</span>
        <span className="agent-spacer" />
        <a className="btn-text" href="/automation-guide.html" target="_blank" rel="noreferrer">
          使用说明 ↗
        </a>
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
                        : t.source.type === "once"
                          ? `${time(Date.parse(t.source.at || ""))}（一次）`
                          : t.source.expression}{" "}
                  ·{" "}
                  {t.steps
                    ? `${t.steps.length} 个步骤`
                    : t.action?.type === "agent"
                      ? "Agent 任务"
                      : "脚本"}
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
        <AutomationEditor
          initial={draft}
          catalog={catalog}
          agents={agents}
          machine={params.get("machine") || ""}
          onSave={save}
          onClose={() => setDraft(null)}
        />
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
            {detail.result?.steps ? (
              detail.result.steps.map((step) => (
                <details key={step.id} open className="auto-result-step">
                  <summary>
                    {step.id} · {status[step.status] || step.status}
                  </summary>
                  {step.agent_id && (
                    <a href={"/agent?conversation=" + encodeURIComponent(step.agent_id)}>
                      打开 Agent 会话
                    </a>
                  )}
                  {step.error && <p className="auto-error">{step.error}</p>}
                  {step.output && (
                    <>
                      <h4>输出</h4>
                      <pre className="auto-log">{step.output.text || "空输出"}</pre>
                    </>
                  )}
                  {step.stderr && (
                    <>
                      <h4>诊断日志</h4>
                      <pre className="auto-log">{step.stderr}</pre>
                    </>
                  )}
                </details>
              ))
            ) : (
              <>
                {detail.result?.agent_id && (
                  <a href={"/agent?conversation=" + detail.result.agent_id}>打开 Agent 会话</a>
                )}
              </>
            )}
            <details>
              <summary>完整运行日志</summary>
              <pre className="auto-log">{detail.log || "无诊断日志"}</pre>
            </details>
            <button className="btn" onClick={() => setDetail(null)}>
              关闭
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
