import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve as pathResolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { Failure } from "./contracts.mjs";
import { resolve, stringify } from "./values.mjs";
export const scriptRoot = (config) =>
  config.scriptDir || join(config.workspace || "/workspace/woc", "automation/scripts");
export function scriptPath(config, name) {
  if (!/^[a-zA-Z0-9_.-]+\.(py|sh)$/.test(name)) throw new Failure("Invalid script filename");
  const root = realpathSync(scriptRoot(config)),
    path = realpathSync(join(root, name));
  if (!path.startsWith(root + sep) || !statSync(path).isFile())
    throw new Failure("Script is outside the script directory");
  return path;
}
export function describe(config, name) {
  const path = scriptPath(config, name),
    meta = path.replace(/\.(py|sh)$/, ".action.json");
  const base = {
    id: name,
    title: name,
    language: name.endsWith(".py") ? "Python" : "Shell",
    parameters: [],
  };
  if (!existsSync(meta)) return { ...base, raw: true };
  if (statSync(meta).size > 65536) throw new Failure("Script metadata exceeds 64 KiB");
  const data = JSON.parse(readFileSync(meta, "utf8"));
  if (!Array.isArray(data.parameters) || data.parameters.length > 32)
    throw new Failure("Invalid script parameters");
  if (
    (data.title !== undefined && typeof data.title !== "string") ||
    (data.description !== undefined && typeof data.description !== "string")
  )
    throw new Failure("Invalid script description");
  if (
    data.outputs !== undefined &&
    (!Array.isArray(data.outputs) ||
      data.outputs.length > 64 ||
      data.outputs.some((v) => typeof v !== "string" || !/^[a-zA-Z0-9_.]+$/.test(v)))
  )
    throw new Failure("Invalid output fields");
  const names = new Set();
  for (const p of data.parameters) {
    if (
      !/^[a-z][a-z0-9_-]*$/.test(p.name) ||
      names.has(p.name) ||
      !["string", "number", "boolean"].includes(p.type)
    )
      throw new Failure("Invalid parameter definition");
    if (
      (p.label !== undefined && typeof p.label !== "string") ||
      (p.help !== undefined && typeof p.help !== "string") ||
      (p.depends_on !== undefined &&
        (!Array.isArray(p.depends_on) || p.depends_on.some((v) => typeof v !== "string"))) ||
      (p.when && (typeof p.when.field !== "string" || typeof p.when.ends_with !== "string"))
    )
      throw new Failure("Invalid parameter presentation");
    if (
      p.options &&
      (!Array.isArray(p.options) ||
        p.options.length > 200 ||
        p.options.some(
          (o) =>
            typeof o !== "string" &&
            (!o || typeof o.value !== "string" || typeof o.label !== "string"),
        ))
    )
      throw new Failure("Invalid parameter options");
    names.add(p.name);
  }
  return {
    ...base,
    title: data.title || name,
    description: data.description || "",
    parameters: data.parameters,
    outputs: data.outputs || [],
  };
}
export function catalog(config) {
  const root = scriptRoot(config);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => /\.(py|sh)$/.test(n))
    .slice(0, 200)
    .map((n) => {
      try {
        return describe(config, n);
      } catch (e) {
        return { id: n, title: n, error: e.message };
      }
    });
}
export function commandFor(config, action, context = {}) {
  const env = Object.fromEntries(
    Object.entries(action.env || {}).map(([k, v]) => [k, stringify(resolve(v, context))]),
  );
  const args = (action.args || []).map((v) => stringify(resolve(v, context)));
  if (!action.script) return { ...action, args, env };
  const meta = describe(config, action.script),
    path = scriptPath(config, action.script);
  if (meta.raw)
    return {
      ...action,
      command: meta.language === "Python" ? "python3" : "bash",
      args: [path, ...args],
      env,
    };
  const params = action.params || {};
  for (const name of Object.keys(params))
    if (!meta.parameters.some((p) => p.name === name))
      throw new Failure(`Unknown parameter: ${name}`);
  const argv = [];
  for (const p of meta.parameters) {
    if (p.when && !String(resolve(params[p.when.field] ?? "", context)).endsWith(p.when.ends_with))
      continue;
    const v = resolve(params[p.name] ?? p.default ?? "", context);
    if (v === "" || v === null || v === undefined) {
      if (p.required) throw new Failure(`Required parameter: ${p.name}`);
      continue;
    }
    if (p.type === "boolean") {
      if (![true, false, "true", "false"].includes(v))
        throw new Failure(`Expected boolean: ${p.name}`);
      if (v === true || v === "true") argv.push("--" + p.name);
      continue;
    }
    if (
      p.type === "number" &&
      (!Number.isFinite(Number(v)) ||
        (p.min != null && Number(v) < p.min) ||
        (p.max != null && Number(v) > p.max))
    )
      throw new Failure(`Invalid number: ${p.name}`);
    if (p.options && !p.options.some((o) => String(o.value ?? o) === String(v)))
      throw new Failure(`Invalid option: ${p.name}`);
    argv.push("--" + p.name, stringify(v));
  }
  return {
    ...action,
    command: meta.language === "Python" ? "python3" : "bash",
    args: [path, ...argv, ...args],
    env,
  };
}
export function inspectScript(config, name, args, context = {}) {
  const path = scriptPath(config, name);
  return new Promise((res, rej) => {
    const child = execFile(
      name.endsWith(".py") ? "python3" : "bash",
      [path, ...args],
      {
        timeout: 4000,
        killSignal: "SIGKILL",
        detached: true,
        maxBuffer: 65536,
        cwd: config.workspace || pathResolve(scriptRoot(config), "../.."),
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: "C.UTF-8",
          WOC_CLIENT_CONFIG: config.wocClientConfig || "",
          WOC_OPTIONS_CONTEXT: JSON.stringify(context),
        },
      },
      (err, stdout, stderr) => {
        if (child.pid)
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        err ? rej(new Failure(stderr.slice(-2000) || err.message)) : res(stdout);
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(context));
  });
}
