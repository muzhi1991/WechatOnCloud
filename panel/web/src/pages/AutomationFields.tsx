import { useEffect, useRef, useState } from "react";
import { job, type Option, type Parameter, type Step, type Script } from "./automation-model";
export function Variables({
  steps,
  onSelect,
}: {
  steps: Step[];
  onSelect: (value: string) => void;
}) {
  const values = [
    ["触发时间", "trigger.received_at"],
    ["触发数据", "trigger.body"],
    ["触发电脑", "trigger.machine_id"],
    ["上一步文本", "input.text"],
    ["上一步 JSON", "input.json"],
    ["运行 ID", "run.id"],
    ...steps.flatMap((s) => [
      [`${s.id} 文本`, `steps.${s.id}.text`],
      [`${s.id} JSON`, `steps.${s.id}.json`],
      ...(s.output_fields || [])
        .filter((k) => /^[a-zA-Z0-9_.]+$/.test(k))
        .map((k) => [`${s.id} · ${k}`, `steps.${s.id}.json.${k}`]),
    ]),
  ];
  return (
    <select
      className="auto-variable"
      aria-label="插入变量"
      value=""
      onChange={(e) => {
        if (e.target.value) onSelect("{{" + e.target.value + "}}");
      }}
    >
      <option value="">＋ 插入变量</option>
      {values.map(([label, v]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );
}
export function ValueField({
  value,
  onChange,
  steps,
  multiline = false,
  inputType = "text",
  label,
  required,
  min,
  max,
}: {
  value: string;
  onChange: (v: string) => void;
  steps: Step[];
  multiline?: boolean;
  inputType?: "text" | "number";
  label?: string;
  required?: boolean;
  min?: number;
  max?: number;
}) {
  return (
    <div className="auto-value">
      {multiline ? (
        <textarea
          aria-label={label}
          required={required}
          rows={4}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          aria-label={label}
          type={inputType}
          required={required}
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <Variables steps={steps} onSelect={(v) => onChange(value + v)} />
    </div>
  );
}
function OptionsField({
  script,
  param,
  values,
  value,
  onChange,
}: {
  script: string;
  param: Parameter;
  values: Step["params"];
  value: string;
  onChange: (v: string) => void;
}) {
  const [items, setItems] = useState<Option[]>([]),
    [query, setQuery] = useState(""),
    [kind, setKind] = useState("sessions"),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const dep = JSON.stringify((param.depends_on || []).map((k) => values?.[k]));
  const available = (param.depends_on || []).every(
    (k) => !!values?.[k] && !String(values[k]).includes("{{"),
  );
  const load = async (next = false) => {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setBusy(true);
    setError("");
    try {
      const r = await job<{ items: Option[]; next_cursor: string | null; limited?: boolean }>(
        "options",
        {
          script,
          parameter: param.name,
          params: values,
          query,
          kind,
          cursor: next ? cursor : null,
        },
        c.signal,
      );
      if (!c.signal.aborted) {
        setItems((old) => (next ? [...old, ...r.items] : r.items));
        setCursor(r.next_cursor);
        if (r.limited) setError("结果上限 500 条，请缩小搜索范围。");
      }
    } catch (e) {
      if (!c.signal.aborted) setError((e as Error).message);
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  };
  useEffect(() => {
    controller.current?.abort();
    setItems([]);
    setCursor(null);
    setError("");
    setBusy(false);
    if (available) void load();
    return () => controller.current?.abort();
  }, [dep, kind, script, param.name]);
  return (
    <div className="auto-options">
      {param.provider === "wechat.chats" && (
        <select aria-label="查找范围" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="sessions">最近会话</option>
          <option value="contacts">联系人</option>
          <option value="groups">群聊</option>
        </select>
      )}
      {param.provider !== "machines" && (
        <div className="auto-inline">
          <input
            aria-label={`${param.label}搜索`}
            placeholder="搜索名称或 ID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void load();
              }
            }}
          />
          <button
            type="button"
            className="btn"
            disabled={!available || busy}
            onClick={() => void load()}
          >
            查找
          </button>
        </div>
      )}
      <select
        aria-label={param.label || param.name}
        required={param.required}
        value={value}
        disabled={!available || busy}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{busy ? "读取中…" : available ? "请选择" : "先选择上方依赖项"}</option>
        {value && !items.some((i) => i.value === value) && <option value={value}>{value}</option>}
        {items.map((i) => (
          <option key={i.value} value={i.value}>
            {i.label}
            {param.provider !== "machines" ? ` · ${i.value}` : ""}
          </option>
        ))}
      </select>
      {cursor && (
        <button type="button" className="btn-text" disabled={busy} onClick={() => void load(true)}>
          加载更多
        </button>
      )}
      {error && (
        <small role="alert" className="auto-error">
          {error}{" "}
          <button type="button" className="btn-text" onClick={() => void load()}>
            重试
          </button>
        </small>
      )}
    </div>
  );
}
export function Parameters({
  script,
  step,
  previous,
  onChange,
}: {
  script: Script;
  step: Step;
  previous: Step[];
  onChange: (s: Step) => void;
}) {
  const values = step.params || {};
  const change = (p: Parameter, v: string | number | boolean) => {
    const params = { ...values, [p.name]: v };
    const dirty = new Set([p.name]);
    for (const q of script.parameters)
      if (q.depends_on?.some((k) => dirty.has(k))) {
        params[q.name] = "";
        dirty.add(q.name);
      }
    onChange({ ...step, params });
  };
  return (
    <>
      {script.parameters
        .filter((p) => !p.when || String(values[p.when.field] || "").endsWith(p.when.ends_with))
        .map((p) => {
          const value = values[p.name] ?? p.default ?? "";
          return (
            <div className="auto-param" key={p.name}>
              <span className="auto-field-label">
                {p.label || p.name}
                {p.required ? " *" : ""}{" "}
                {p.help && (
                  <span tabIndex={0} title={p.help} className="auto-info" aria-label={p.help}>
                    ⓘ
                  </span>
                )}
              </span>
              {p.provider ? (
                <OptionsField
                  script={script.id}
                  param={p}
                  values={values}
                  value={String(value)}
                  onChange={(v) => change(p, v)}
                />
              ) : p.options ? (
                <EnumField parameter={p} value={String(value)} onChange={(v) => change(p, v)} />
              ) : p.type === "boolean" ? (
                <label className="auto-toggle">
                  <input
                    type="checkbox"
                    checked={value === true || value === "true"}
                    onChange={(e) => change(p, e.target.checked)}
                  />
                  启用
                </label>
              ) : (
                <ValueField
                  label={p.label || p.name}
                  required={p.required}
                  inputType={
                    p.type === "number" && !String(value).includes("{{") ? "number" : "text"
                  }
                  min={p.min}
                  max={p.max}
                  value={String(value)}
                  onChange={(v) => change(p, v)}
                  steps={previous}
                />
              )}
              {(p.provider || p.options || p.type === "boolean") && (
                <details className="auto-minor">
                  <summary>使用变量或准确 ID</summary>
                  <ValueField
                    value={String(value)}
                    onChange={(v) => change(p, v)}
                    steps={previous}
                  />
                </details>
              )}
            </div>
          );
        })}
    </>
  );
}

function EnumField({
  parameter: p,
  value,
  onChange,
}: {
  parameter: Parameter;
  value: string;
  onChange: (v: string) => void;
}) {
  const [query, setQuery] = useState("");
  const items = (p.options || []).map((o) => (typeof o === "string" ? { label: o, value: o } : o));
  if (items.length <= 4)
    return (
      <div className="auto-segments" role="group" aria-label={p.label}>
        {items.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    );
  return (
    <div className="auto-options">
      <input
        placeholder="筛选选项"
        aria-label={`${p.label}筛选`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <select aria-label={p.label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">请选择</option>
        {items
          .filter((o) => o.value === value || o.label.toLowerCase().includes(query.toLowerCase()))
          .map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
      </select>
    </div>
  );
}
