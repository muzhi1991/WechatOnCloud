#!/usr/bin/env node
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const [cmd, id] = args;
const option = (n) => {
  const i = args.indexOf(n);
  return i < 0 ? undefined : args[i + 1];
};
const url = process.env.WOC_TRIGGER_URL || "http://127.0.0.1:6771";
const token = readFileSync(
  process.env.WOC_TRIGGER_TOKEN_FILE || "/state/automation/admin.token",
  "utf8",
).trim();
async function call(method, path, data) {
  const r = await fetch(url + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(15000),
  });
  const v = await r.json();
  if (!r.ok) throw Error(v.error);
  return v;
}
try {
  let result;
  if (cmd === "list") result = await call("GET", "/triggers");
  else if (cmd === "health") result = await call("GET", "/health");
  else if (cmd === "agents") result = await call("GET", "/agents");
  else if (cmd === "create" || cmd === "update") {
    const input = JSON.parse(readFileSync(option("--file") || 0, "utf8"));
    result = await call(
      cmd === "create" ? "POST" : "PUT",
      "/triggers" + (cmd === "update" ? "/" + encodeURIComponent(id) : ""),
      input,
    );
  } else if (cmd === "run")
    result = await call(
      "POST",
      `/triggers/${encodeURIComponent(id)}/run`,
      option("--input-file") ? JSON.parse(readFileSync(option("--input-file"), "utf8")) : {},
    );
  else if (cmd === "delete") result = await call("DELETE", `/triggers/${encodeURIComponent(id)}`);
  else if (cmd === "pause" || cmd === "resume") {
    const t = (await call("GET", "/triggers")).triggers.find((t) => t.id === id);
    if (!t) throw Error("Trigger not found");
    result = await call("PUT", `/triggers/${encodeURIComponent(id)}`, {
      ...t,
      enabled: cmd === "resume",
    });
  } else if (cmd === "runs")
    result = await call("GET", "/runs" + (id ? "?trigger_id=" + encodeURIComponent(id) : ""));
  else if (cmd === "log") result = await call("GET", "/runs/" + encodeURIComponent(id));
  else if (cmd === "agent" && id === "send") {
    const agent = option("--agent"),
      file = option("--message-file");
    if (!agent || !file) throw Error("Use agent send --agent ID --message-file FILE");
    result = await call("POST", "/agent-tasks", {
      action: {
        agent_id: agent,
        message: readFileSync(file, "utf8"),
        include_input: false,
        timeout_seconds: Number(option("--timeout") || 1800),
      },
      idempotency_key: option("--key"),
    });
  } else
    throw Error(
      "Commands: list, create --file, update ID --file, pause/resume/delete/run ID, runs [ID], log RUN_ID, agents, agent send --agent ID --message-file FILE [--key KEY]",
    );
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
