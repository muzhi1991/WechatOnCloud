// One-time setup inside the trusted Agent container. Never prints credentials.
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { randomUUID, randomBytes, createHash } from "node:crypto";
const dir = "/state/automation";
mkdirSync(dir, { recursive: true, mode: 0o700 });
const identityPath = dir + "/identity.json";
if (!existsSync(identityPath))
  writeFileSync(
    identityPath,
    JSON.stringify({ id: randomUUID(), token: randomBytes(32).toString("hex") }),
    { mode: 0o600, flag: "wx" },
  );
const identity = JSON.parse(readFileSync(identityPath, "utf8"));
const panel = process.env.WOC_PANEL_URL;
const r = await fetch(new URL("/api/integrations/agent/clients", panel), {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: "Bearer " + readFileSync(process.env.WOC_PROVISION_TOKEN_FILE, "utf8").trim(),
  },
  body: JSON.stringify({
    agentId: identity.id,
    label: "自动化服务",
    tokenHash: createHash("sha256").update(identity.token).digest("hex"),
  }),
  signal: AbortSignal.timeout(10000),
});
if (!r.ok) throw Error("Automation identity registration failed: " + r.status);
writeFileSync(dir + "/woc.token", identity.token, { mode: 0o600 });
writeFileSync(
  dir + "/client.json",
  JSON.stringify({ panelUrl: panel, tokenFile: dir + "/woc.token" }),
  { mode: 0o600 },
);
const config = {
  host: "127.0.0.1",
  port: 6771,
  stateDir: dir,
  workspace: "/workspace/woc",
  wocClientConfig: dir + "/client.json",
  connections: {
    woc: {
      command: "node",
      args: ["/opt/woc/integrations/woc-mcp/server.mjs", dir + "/client.json"],
    },
  },
};
if (!existsSync(dir + "/config.json"))
  writeFileSync(dir + "/config.json", JSON.stringify(config, null, 2), { mode: 0o600, flag: "wx" });
console.log("Automation configuration and separate WOC identity ready");

// Seed only missing examples. User scripts are never overwritten by startup.
const scripts = "/workspace/woc/automation/scripts";
mkdirSync(scripts, { recursive: true, mode: 0o700 });
for (const name of readdirSync(new URL("../scripts/", import.meta.url))) {
  if (!existsSync(scripts + "/" + name))
    copyFileSync(new URL("../scripts/" + name, import.meta.url), scripts + "/" + name);
}
