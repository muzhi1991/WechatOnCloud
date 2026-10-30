import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Failure } from "./contracts.mjs";
import { describe, inspectScript } from "./scripts.mjs";
export async function woc(config, path, body) {
  if (!config.wocClientConfig) throw new Failure("WOC read connection is not configured");
  const c = JSON.parse(readFileSync(config.wocClientConfig, "utf8"));
  const token = readFileSync(c.tokenFile, "utf8").trim();
  const r = await fetch(c.panelUrl.replace(/\/$/, "") + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(110000),
  });
  const data = await r.json();
  if (!r.ok) throw new Failure(data.error || "WOC query failed");
  return data;
}
export async function discover(config, connection) {
  const cfg = config.connections?.[connection];
  if (!cfg) throw new Failure("Unknown MCP connection");
  const c = new Client({ name: "woc-trigger-discovery", version: "0.2.0" });
  try {
    await c.connect(
      new StdioClientTransport({
        command: cfg.command,
        args: cfg.args || [],
        env: { ...process.env, ...cfg.env },
        stderr: "ignore",
      }),
      { timeout: 10000 },
    );
    const capabilities = c.getServerCapabilities();
    if (!capabilities?.resources) return { resources: [], templates: [], subscribe: false };
    const resources = [];
    let cursor,
      pages = 0;
    do {
      const r = await c.listResources(cursor ? { cursor } : {}, { timeout: 10000 });
      resources.push(...r.resources);
      cursor = r.nextCursor;
    } while (cursor && resources.length < 200 && ++pages < 10);
    let templates = [];
    try {
      templates = (await c.listResourceTemplates({}, { timeout: 5000 })).resourceTemplates;
    } catch {}
    return {
      subscribe: !!capabilities.resources.subscribe,
      resources: resources.slice(0, 200).map((r) => ({
        ...r,
        machine_id: /^wechat:\/\/([^/]+)/.exec(r.uri)?.[1] || "",
        ready: !!capabilities.resources.subscribe,
      })),
      templates: templates.slice(0, 200),
    };
  } finally {
    await c.close();
  }
}
export async function options(config, b) {
  if (b.provider === "machines") {
    const r = await woc(config, "/api/integrations/woc/machines", {});
    return { items: r.machines.map((m) => ({ value: m.id, label: m.name })), next_cursor: null };
  }
  let provider = b.provider;
  if (b.script) {
    const p = describe(config, b.script).parameters.find((p) => p.name === b.parameter);
    if (!p?.provider) throw new Failure("Parameter has no options provider");
    provider = p.provider;
    if (provider === "script") {
      const value = JSON.parse(
        await inspectScript(config, b.script, ["--list-options", b.parameter], {
          params: b.params || {},
          query: b.query || "",
          cursor: b.cursor || null,
        }),
      );
      if (
        !Array.isArray(value.items) ||
        value.items.length > 200 ||
        value.items.some((i) => typeof i.value !== "string" || typeof i.label !== "string")
      )
        throw new Failure("Invalid options result");
      return value;
    }
  }
  if (provider === "machines") return options(config, { provider });
  if (!["wechat.chats", "wechat.members"].includes(provider))
    throw new Failure("Unknown options provider");
  const machine = b.params?.machine;
  if (!/^[a-zA-Z0-9_-]+$/.test(machine || "")) throw new Failure("Choose a computer first");
  const kind =
    provider === "wechat.members"
      ? "members"
      : ["sessions", "contacts", "groups"].includes(b.kind)
        ? b.kind
        : "sessions";
  const query = String(b.query || "").slice(0, 256);
  const input =
    kind === "members"
      ? { chat: b.params.chat }
      : { limit: 500, ...(query && kind !== "sessions" ? { query } : {}) };
  const data = await woc(config, `/api/integrations/wechat/${machine}/${kind}`, input);
  let list = Array.isArray(data) ? data : data[kind] || data.members || [];
  list = list
    .map((c) => ({
      value: c.username || c.user_name || c.id,
      label: c.chat || c.display || c.display_name || c.nickname || c.name || c.username,
    }))
    .filter((c) => c.value && c.label);
  if (query)
    list = list.filter((c) =>
      (c.label + " " + c.value).toLowerCase().includes(query.toLowerCase()),
    );
  const offset = Math.max(0, Number(b.cursor) || 0);
  return {
    items: list.slice(offset, offset + 50),
    next_cursor: offset + 50 < list.length ? String(offset + 50) : null,
    limited: kind !== "members" && list.length >= 500,
  };
}
