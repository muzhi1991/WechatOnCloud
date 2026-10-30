import { mkdirSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { tailText } from "./values.mjs";
export function directoryBytes(path, limit) {
  let total = 0;
  for (const item of readdirSync(path, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const p = join(path, item.name);
    total += item.isDirectory() ? directoryBytes(p, limit - total) : statSync(p).size;
    if (total > limit) break;
  }
  return total;
}
export async function runScript(config, action, run, stepId, input, context, signal, append) {
  const state = join(config.stateDir, "scripts", run.trigger_id || "manual");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  if (directoryBytes(state, 16 * 1024 * 1024) > 16 * 1024 * 1024)
    throw Error("Script state exceeds 16 MiB");
  const files = join(config.stateDir, "inputs", run.id, stepId);
  try {
    mkdirSync(files, { recursive: true, mode: 0o700 });
    for (const [name, value] of Object.entries({
      trigger: JSON.stringify(context.trigger),
      input,
      context: JSON.stringify(context),
    }))
      writeFileSync(join(files, name + ".json"), value, { mode: 0o600 });
    return await new Promise((res, rej) => {
      let stdout = "",
        stderr = "",
        bytes = 0,
        outputError;
      const child = spawn(action.command, action.args, {
        cwd: action.cwd,
        detached: true,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: "C.UTF-8",
          TZ: process.env.TZ || "Asia/Shanghai",
          ...action.env,
          WOC_TRIGGER_URL: `http://127.0.0.1:${config.port}`,
          WOC_TRIGGER_TOKEN_FILE: config.tokenFile,
          WOC_TRIGGER_STATE_DIR: state,
          WOC_CLIENT_CONFIG: config.wocClientConfig || "",
          WOC_TRIGGER_CLI: new URL("./cli.mjs", import.meta.url).pathname,
          WOC_RUN_ID: run.id,
          WOC_STEP_ID: stepId,
          WOC_MACHINE_ID: context.trigger.machine_id || "",
          WOC_TRIGGER_FILE: join(files, "trigger.json"),
          WOC_INPUT_FILE: join(files, "input.json"),
          WOC_CONTEXT_FILE: join(files, "context.json"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let killTimer;
      const kill = () => {
        if (!child.pid || killTimer) return;
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
        killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }, 1000);
        killTimer.unref();
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d) => {
        bytes += Buffer.byteLength(d);
        if (bytes > 262144) {
          outputError = Error("Step stdout exceeds 256 KiB");
          kill();
        } else stdout += d;
      });
      child.stderr.on("data", (d) => {
        stderr = tailText(stderr + d, 16384);
        append(d);
      });
      child.stdin.on("error", () => {});
      const quota = setInterval(() => {
        try {
          if (directoryBytes(state, 16 * 1024 * 1024) > 16 * 1024 * 1024) {
            outputError = Error("Script state exceeds 16 MiB");
            kill();
          }
        } catch (e) {
          outputError = e;
          kill();
        }
      }, 1000);
      signal.addEventListener("abort", kill, { once: true });
      if (signal.aborted) kill();
      child.on("error", rej);
      child.on("close", (code, sig) => {
        clearInterval(quota);
        clearTimeout(killTimer);
        signal.removeEventListener("abort", kill);
        if (child.pid)
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        if (signal.aborted) rej(signal.reason);
        else if (outputError) rej(outputError);
        else if (code !== 0) rej(Error(`Script exited ${code ?? sig}`));
        else res({ text: stdout, stderr, exit_code: code });
      });
      child.stdin.end(input);
    });
  } finally {
    rmSync(join(config.stateDir, "inputs", run.id), { recursive: true, force: true });
  }
}
