import { Cron } from "croner";
export class Failure extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const text = (v, name, max = 512) => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new Failure(`Invalid ${name}`);
  return v;
};
export function validate(input, connections = {}) {
  if (!input || typeof input !== "object") throw new Failure("Expected a trigger");
  const name = text(input.name, "name", 120);
  if (typeof input.enabled !== "boolean") throw new Failure("enabled must be boolean");
  const source = input.source,
    action = input.action;
  if (!source || !["mcp", "webhook", "interval", "cron"].includes(source.type))
    throw new Failure("Unsupported source");
  let s = { type: source.type };
  if (source.type === "mcp") {
    if (!Object.hasOwn(connections, source.connection)) throw new Failure("Unknown MCP connection");
    s = { ...s, connection: source.connection, uri: text(source.uri, "resource URI", 2048) };
  }
  if (source.type === "interval") {
    if (!Number.isInteger(source.seconds) || source.seconds < 5 || source.seconds > 31536000)
      throw new Failure("Interval must be 5..31536000 seconds");
    s.seconds = source.seconds;
  }
  if (source.type === "cron") {
    s.expression = text(source.expression, "cron", 120);
    s.timezone = text(source.timezone, "timezone", 80);
    if (s.expression.trim().split(/\s+/).length !== 5) throw new Failure("Use five-field cron");
    try {
      new Intl.DateTimeFormat("en", { timeZone: s.timezone });
      const cron = new Cron(s.expression, { timezone: s.timezone, paused: true });
      if (!cron.nextRun()) throw Error();
      cron.stop();
    } catch {
      throw new Failure("Invalid cron or timezone");
    }
  }
  if (!action || !["script", "agent"].includes(action.type))
    throw new Failure("Unsupported action");
  const timeout = action.timeout_seconds ?? 300;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600)
    throw new Failure("Timeout must be 1..3600 seconds");
  let a = { type: action.type, timeout_seconds: timeout };
  if (action.type === "script") {
    a.command = text(action.command, "command");
    if (
      !Array.isArray(action.args) ||
      action.args.length > 64 ||
      action.args.some((v) => typeof v !== "string" || v.length > 8192)
    )
      throw new Failure("args must be a string array");
    a.args = action.args;
    a.cwd = text(action.cwd, "working directory", 2048);
    if (!a.cwd.startsWith("/")) throw new Failure("Working directory must be absolute");
  } else {
    a.agent_id = text(action.agent_id, "agent ID", 128);
    a.message = text(action.message, "message", 32768);
    a.include_input = action.include_input !== false;
  }
  return { name, enabled: input.enabled, source: s, action: a };
}
export function nextDue(source, now) {
  if (source.type === "interval") return now + source.seconds * 1000;
  if (source.type === "cron") {
    const c = new Cron(source.expression, { timezone: source.timezone, paused: true });
    const date = c.nextRun(new Date(now));
    c.stop();
    return date?.getTime() ?? null;
  }
  return null;
}
