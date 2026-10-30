export type Source = {
  type: string;
  seconds?: number;
  expression?: string;
  timezone?: string;
  at?: string;
  connection?: string;
  uri?: string;
};
export type Step = {
  output_fields?: string[];
  id: string;
  type: string;
  script?: string;
  params?: Record<string, string | number | boolean>;
  command?: string;
  args?: string[];
  cwd?: string;
  agent_id?: string;
  message?: string;
  include_input?: boolean;
  timeout_seconds: number;
  skip_empty?: boolean;
  env?: Record<string, string>;
};
export type Trigger = {
  id?: string;
  name: string;
  enabled: boolean;
  source: Source;
  steps?: Step[];
  action?: Omit<Step, "id">;
  next_run?: number;
  webhook_secret?: string;
};
export type Agent = { id: string; title: string; archived: boolean; status: string };
export type Option = { value: string; label: string };
export type Parameter = {
  name: string;
  label?: string;
  type: string;
  required?: boolean;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  help?: string;
  options?: (string | Option)[];
  provider?: string;
  depends_on?: string[];
  when?: { field: string; ends_with: string };
};
export type Script = {
  id: string;
  title: string;
  description?: string;
  language?: string;
  error?: string;
  raw?: boolean;
  parameters: Parameter[];
  outputs?: string[];
};
export type Catalog = {
  connections: string[];
  scripts: Script[];
  script_dir: string;
  workspace: string;
};
export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const r = await fetch("/api/automation/" + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const value = await r.json();
  if (!r.ok) throw Error(value.error || "请求失败");
  return value;
}
export async function job<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const { job_id } = await request<{ job_id: string }>(path, "POST", body, signal);
  for (let i = 0; i < 240; i++) {
    if (signal?.aborted) throw Error("已取消");
    const r = await request<{ status: string; result: T; error?: string }>(
      "jobs/" + job_id,
      "GET",
      undefined,
      signal,
    );
    if (r.status === "succeeded") return r.result;
    if (r.status === "failed") throw Error(r.error);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error("查询超时，请重试");
}
export const newStep = (type = "script"): Step => ({
  id:
    "step_" +
    Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join(""),
  type,
  timeout_seconds: type === "agent" ? 1800 : 300,
  ...(type === "agent"
    ? { agent_id: "", message: "", include_input: false }
    : { script: "", params: {}, args: [], cwd: "/workspace/woc" }),
});
