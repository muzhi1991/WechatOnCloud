import { useEffect, useState } from "react";
import { job, request, type Source, type Catalog, type Option } from "./automation-model";
type Resource = { uri: string; name: string; machine_id: string; ready: boolean };
export default function AutomationSource({
  value: s,
  onChange,
  catalog,
}: {
  value: Source;
  onChange: (s: Source) => void;
  catalog: Catalog;
}) {
  const [machine, setMachine] = useState(/^wechat:\/\/([^/]+)/.exec(s.uri || "")?.[1] || ""),
    [machines, setMachines] = useState<Option[]>([]),
    [resources, setResources] = useState<Resource[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0),
    [dates, setDates] = useState<string[]>([]);
  const [mode, setMode] = useState(
    s.type === "cron" && /^\d+ \d+ \* \* \*$/.test(s.expression || "") ? "daily" : "advanced",
  );
  useEffect(() => {
    const id = /^wechat:\/\/([^/]+)/.exec(s.uri || "")?.[1];
    if (id) setMachine(id);
  }, [s.uri]);
  useEffect(() => {
    if (s.type !== "mcp") return;
    const c = new AbortController();
    void job<{ items: Option[] }>("options", { provider: "machines" }, c.signal)
      .then((r) => setMachines(r.items))
      .catch(() => {});
    return () => c.abort();
  }, [s.type]);
  useEffect(() => {
    if (s.type !== "mcp" || !s.connection) return;
    const c = new AbortController();
    setBusy(true);
    setError("");
    setResources([]);
    void job<{ resources: Resource[]; subscribe: boolean }>(
      "discover",
      { connection: s.connection },
      c.signal,
    )
      .then((r) => {
        if (c.signal.aborted) return;
        setResources(r.resources);
        if (!r.subscribe) setError("此 MCP 服务不支持资源订阅。");
        else if (!r.resources.length) setError("没有可订阅资源，请检查读取服务是否已配置并在线。");
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!c.signal.aborted) setBusy(false);
      });
    return () => c.abort();
  }, [s.type, s.connection, revision]);
  useEffect(() => {
    setDates([]);
    if (!["interval", "cron", "once"].includes(s.type)) return;
    const c = new AbortController();
    const timer = setTimeout(
      () =>
        void request<{ dates: string[] }>("schedule-preview", "POST", s, c.signal)
          .then((r) => {
            setDates(r.dates);
            setError("");
          })
          .catch((e) => {
            if (!c.signal.aborted) setError(e.message);
          }),
      350,
    );
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [JSON.stringify(s)]);
  const cron = s.expression?.split(" ") || ["0", "9", "*", "*", "*"];
  const setTime = (time: string, day?: string) => {
    const [h, m] = time.split(":");
    onChange({
      ...s,
      expression: `${Number(m)} ${Number(h)} ${mode === "monthly" ? day || cron[2] : "*"} * ${mode === "weekly" ? day || cron[4] : "*"}`,
    });
  };
  return (
    <fieldset>
      <legend>1 · 什么时候触发</legend>
      <select
        aria-label="触发条件"
        value={s.type}
        onChange={(e) => {
          setError("");
          const type = e.target.value;
          if (type === "cron") setMode("daily");
          onChange(
            type === "mcp"
              ? { type, connection: catalog.connections[0] || "", uri: "" }
              : type === "interval"
                ? { type, seconds: 60 }
                : type === "cron"
                  ? { type, expression: "0 9 * * *", timezone: "Asia/Shanghai" }
                  : type === "once"
                    ? { type, at: new Date(Date.now() + 3600000).toISOString() }
                    : { type },
          );
        }}
      >
        <option value="interval">每隔一段时间</option>
        <option value="cron">按日历重复</option>
        <option value="once">指定日期（一次）</option>
        <option value="mcp">MCP 资源更新</option>
        <option value="webhook">Webhook 通知</option>
      </select>
      {s.type === "interval" && (
        <label>
          间隔（秒）
          <input
            type="number"
            required
            min={5}
            max={31536000}
            value={s.seconds}
            onChange={(e) => onChange({ ...s, seconds: Number(e.target.value) })}
          />
        </label>
      )}
      {s.type === "once" && (
        <label>
          执行时间（此浏览器时区）
          <input
            type="datetime-local"
            required
            value={
              s.at
                ? new Date(Date.parse(s.at) - new Date(s.at).getTimezoneOffset() * 60000)
                    .toISOString()
                    .slice(0, 16)
                : ""
            }
            onChange={(e) => {
              if (e.target.value) onChange({ ...s, at: new Date(e.target.value).toISOString() });
            }}
          />
        </label>
      )}
      {s.type === "cron" && (
        <>
          <label>
            重复方式
            <select
              aria-label="重复方式"
              value={mode}
              onChange={(e) => {
                const m = e.target.value;
                setMode(m);
                if (m !== "advanced")
                  onChange({
                    ...s,
                    expression: `0 9 ${m === "monthly" ? "1" : "*"} * ${m === "weekly" ? "1" : "*"}`,
                  });
              }}
            >
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
              <option value="advanced">高级 Cron</option>
            </select>
          </label>
          {mode === "advanced" ? (
            <label>
              Cron（分 时 日 月 星期）
              <input
                required
                value={s.expression}
                onChange={(e) => onChange({ ...s, expression: e.target.value })}
              />
            </label>
          ) : (
            <div className="auto-grid">
              <label>
                时间
                <input
                  type="time"
                  value={`${cron[1].padStart(2, "0")}:${cron[0].padStart(2, "0")}`}
                  onChange={(e) => setTime(e.target.value)}
                />
              </label>
              {mode === "weekly" && (
                <label>
                  星期
                  <select
                    aria-label="星期"
                    value={cron[4]}
                    onChange={(e) => setTime(`${cron[1]}:${cron[0]}`, e.target.value)}
                  >
                    {["日", "一", "二", "三", "四", "五", "六"].map((v, i) => (
                      <option key={i} value={i}>
                        星期{v}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {mode === "monthly" && (
                <label>
                  每月几日
                  <input
                    type="number"
                    min={1}
                    max={31}
                    value={cron[2]}
                    onChange={(e) => setTime(`${cron[1]}:${cron[0]}`, e.target.value)}
                  />
                  <small>无对应日期的月份跳过。</small>
                </label>
              )}
            </div>
          )}
          <label>
            时区
            <input
              list="auto-timezones"
              value={s.timezone}
              onChange={(e) => onChange({ ...s, timezone: e.target.value })}
            />
            <datalist id="auto-timezones">
              <option>Asia/Shanghai</option>
              <option>UTC</option>
              <option>America/Los_Angeles</option>
              <option>Europe/London</option>
            </datalist>
          </label>
        </>
      )}
      {dates.length > 0 && (
        <details className="auto-minor">
          <summary>预计执行时间：{new Date(dates[0]).toLocaleString()}</summary>
          {dates.map((d) => (
            <div key={d}>{new Date(d).toLocaleString()}</div>
          ))}
          <small>服务离线期间不补跑；时间按浏览器时区显示。</small>
        </details>
      )}
      {s.type === "mcp" && (
        <>
          <div className="auto-grid">
            <label>
              电脑
              <select
                aria-label="资源电脑"
                value={machine}
                onChange={(e) => {
                  setMachine(e.target.value);
                  onChange({ ...s, uri: "" });
                }}
              >
                <option value="">全部 / 全局资源</option>
                {machine && !machines.some((m) => m.value === machine) && (
                  <option>{machine}</option>
                )}
                {machines.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              MCP 服务
              <select
                aria-label="MCP 服务"
                value={s.connection}
                onChange={(e) => onChange({ ...s, connection: e.target.value, uri: "" })}
              >
                <option value="">请选择</option>
                {catalog.connections.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            订阅资源
            <select
              aria-label="订阅资源"
              value={s.uri}
              disabled={busy}
              onChange={(e) => onChange({ ...s, uri: e.target.value })}
            >
              <option value="">{busy ? "正在发现资源…" : "请选择"}</option>
              {s.uri && !resources.some((r) => r.uri === s.uri) && (
                <option value={s.uri}>{s.uri}（尚未验证）</option>
              )}
              {resources
                .filter((r) => !machine || r.machine_id === machine)
                .map((r) => (
                  <option key={r.uri} value={r.uri} disabled={!r.ready}>
                    {r.name}
                  </option>
                ))}
            </select>
          </label>
          {!busy && machine && !resources.some((r) => r.machine_id === machine) && (
            <small className="muted">该电脑暂无可订阅资源，请确认已配置相应读取服务。</small>
          )}
          <small className="muted">
            只列出已登记服务的资源；微信通知表示数据可能更新，具体内容由后续步骤读取。
          </small>
          <button
            type="button"
            className="btn-text"
            disabled={busy}
            onClick={() => setRevision((r) => r + 1)}
          >
            刷新资源
          </button>
          <details className="auto-minor">
            <summary>手动填写资源 URI</summary>
            <input
              aria-label="资源 URI"
              value={s.uri}
              onChange={(e) => onChange({ ...s, uri: e.target.value })}
            />
          </details>
        </>
      )}
      {s.type === "webhook" && (
        <small className="muted">
          保存后显示专属地址和一次性密钥。外部程序 POST JSON 即可触发；数据通过 stdin
          和触发变量传递。
        </small>
      )}
      {error && (
        <p role="alert" className="auto-error">
          {error}
        </p>
      )}
    </fieldset>
  );
}
