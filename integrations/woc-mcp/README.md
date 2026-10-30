# WOC locks with original Cua

The native `cua-spaces` skill, `cua mcp`, CLI and `cua-spacesd` remain unchanged.
WOC supplies a separate stdio MCP and skill. Stable credentials identify a client;
the panel owns the lock. Ordinary Cua GUI requests carry no new lock parameter.

The adapter also provides optional `woc_wechat_*` read tools and standard resource
subscriptions for configured machines. Run `npm ci --ignore-scripts` in this
directory after updating; the launch command and client credential stay unchanged.
See [read service](../../deploy/read-daemon/README.md) for query arguments, local
media downloads, subscription semantics and deployment. Queries never acquire or
renew the desktop lock. Resource notifications do not automatically wake a model.

## Server identity configuration

Set `WOC_CLIENTS_FILE` to a private JSON file mounted read-only into the panel:

```json
[
  {
    "id": "mac-agent",
    "label": "Mac Agent",
    "tokenHash": "SHA256_OF_A_RANDOM_32_BYTE_OR_LONGER_TOKEN",
    "machines": ["INSTANCE_ID"]
  }
]
```

Generate credentials with a cryptographic random generator; store the original
token in a client file with mode `0600`. Only the SHA-256 digest belongs on the
server. `machines: ["*"]` explicitly grants access to this panel's current and
future managed instances; use a fixed list for restricted clients.

`WOC_CONTROL_IDLE_MS` defaults to 120000 (range 1000–3600000) until an administrator
saves the global Control timeouts settings in the panel (Management → System).
The saved Agent idle value takes precedence and is reported by `idle_timeout_ms`. Only admitted GUI
writes renew a managed client lock. Reading, repeated acquire, commands and agent
calls do not. Human web ownership uses the authenticated user ID across tabs. Ordinary web
requests to another human need that holder’s approval; only administrators may explicitly
force takeover from another human. When an agent owns the lock, an authorized web user
gets a named confirmation before takeover. Cancel sends no takeover request; confirmation
is bound to that exact agent ownership period and fails if ownership has changed. Human web leases expire after either missing heartbeats (default 30 seconds) or
no actual desktop input (default 300 seconds). Heartbeats never renew input activity.
All three timeouts are persisted and configurable, with changes applying immediately. The generic request
model is ready for agents, but agent request/approval MCP tools are not exposed yet.

The same stable credential is used to register the gateway URL in original Cua
and to authenticate WOC MCP. Never put a secret in a model prompt or command log.
Original Cua `add_space` stores it using its existing credential mechanism.
Alternatively, the existing `cua-master-sync` accepts the client credential as its
`serviceTokenFile`; the scoped snapshot then supplies that same credential for
the original gateway endpoints. No Cua source or per-action token changes.

The old service snapshot remains read-only, and the old temporary-lease CLI is
retained for existing jobs. Their leases use the same control engine and cannot
impersonate a stable client by supplying `clientId` in a JSON body.

## Client MCP and skill

Create a private client configuration:

```json
{
  "panelUrl": "http://YOUR_PANEL:36083",
  "tokenFile": "/absolute/private/path/client.token"
}
```

Configure the WOC MCP process as:

```text
node /absolute/repo/integrations/woc-mcp/server.mjs /absolute/private/path/client.json
```

Install/link [woc-control](../skills/woc-control/SKILL.md) into the client's skill
directory. Keep the original `cua-spaces` skill and native Cua MCP connection.
For Codex the native process is `cua --embedded mcp` (embedded avoids dependence
on a separately running local daemon; it is an original Cua runtime option).

WOC tools:

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `woc_machines_list` | none | Scoped machine IDs and original Cua endpoints |
| `woc_lock_status` | `machine_id` | Read state; no acquire or renewal |
| `woc_lock_acquire` | `machine_id` | Acquire for authenticated client; save `lock_id` |
| `woc_lock_release` | `machine_id`, `lock_id` | Release only this exact ownership period |

After acquisition, re-observe with original Cua and operate normally. Release
when finished. A missing/expired/busy lock produces a visible protocol-native
error before forwarding. An uncertain dispatched operation is never advertised
as unexecuted and must not be automatically retried.

## Coverage and boundaries

- All 63 tools in the deployed Driver contract have explicit policies. Batch
  steps and legacy browser `page` are classified from their arguments. Opaque
  GUI scripts/replays require a lock even if a particular script only reads;
  use dedicated observations for reads without a lock.
- GUI gRPC methods and `/mcp` driver calls share the same enforcement. Native
  gRPC-Web errors and MCP `isError` text reach the original client.
- Native process/agent, filesystem and other non-GUI services retain their
  original behavior; streaming output is forwarded incrementally. They do not
  acquire, renew or release the GUI lock. They can indirectly affect the desktop:
  this is the explicitly deferred exception, not a universal security boundary.
- Gateway video and native viewer tickets are forced to view-only with
  observation-only geometry. Media WebSockets accept only tickets issued
  through this gateway. This prevents media `InteractiveInput` bypassing GUI
  locks. Original GUI tools remain the write route. The separately configured
  original Cua App direct connection remains outside lock arbitration.
- Reads do not initialize/reset the driver. Explicit lock acquisition prepares
  control when needed; maintenance and uncertain actions remain blocked.
- Sharing one credential means sharing one lock owner: serialize tasks within
  that client. Same-identity delayed requests after reacquisition cannot be
  distinguished without additional per-task context. Separate concurrent
  clients need distinct Cua configurations/credentials.
- Unknown future GUI tools are refused until classified. An upstream tool
  error (e.g. unsupported background input) is returned unchanged; WOC does
  not turn it into a claimed successful action.

The daemon integration adds the read tools and resource notifications described
above. Optional WeChat UI operations are now available in this same MCP process;
see below. Auto-replies and the web AI conversation remain separate design work. See the [current architecture](../../doc/dev/WOC-Cua-系统架构.md)
for the native Cua port routing, machine registration and container service boundaries.

## WeChat UI operations

The shared contract is `panel/server/src/business/ui-contract.mjs`. Seven tools
use the prefix `woc_wechat_`: `ui_state`, `navigate`, `ui_search`, `open_item`,
`fill_text`, `send_draft`, and `ui_request_status`. All accept `machine_id`.
Only the two observations are lock-free. Writes check the existing client lock;
an optional `lock_id` rejects calls from an earlier ownership period. The adapter
never acquires a lock on behalf of a UI call. Prerequisite errors preserve the
full JSON in both text and `structuredContent`, with MCP `isError`.

Install/link [woc-wechat](../skills/woc-wechat/SKILL.md) for the fixed open-chat and
send-text workflows. Its script explicitly acquires/releases the lock through the
same authenticated HTTP API. It uses currently visible matches first, otherwise
searches the appropriate page; it does not scroll through contact/session lists.
Restart the local WOC MCP connection to refresh tool discovery after updating.
See [UI acceptance and boundaries](../../doc/dev/WOC-WeChat-UI-验收.md).
