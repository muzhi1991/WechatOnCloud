# WOC data and application service

The data-reading path is independent of the application/desktop UI and `cua-spacesd`.
It calls the maintained wx-cli fork, never implements decryption itself, and never
acquires/renews a GUI write lock. Existing Cua and KasmVNC control paths are unchanged.

## Contract

Gateway: `POST /api/integrations/wechat/:machine/:operation`, JSON body. Operations
and MCP schemas share `panel/server/src/business/contract.mjs`. All requests require
the existing WOC client Bearer credential, or an existing web session with access
to the instance. The server maps the authenticated identity to an internal principal;
caller-supplied principal/lock fields do not grant access. The daemon has a separate
per-instance service credential, never returned to clients.

| Operation | Arguments |
| --- | --- |
| health | none |
| sessions | limit |
| unread | limit, filter (private/group/official/folded/all) |
| contacts / groups | query, limit |
| members | chat |
| history | chat, limit, offset, since, until, type |
| search | keyword, chats, limit, since, until, type |
| attachments | chat, kinds, limit, offset, since, until |
| extract | attachment_id |

Prefer exact `username` values returned by contacts/groups/sessions. `limit` is
1..500; dates use YYYY-MM-DD. Query output retains wx-cli shape and snapshot/warning
metadata where provided by that command. Sessions additionally expose
`has_unread = unread > 0`; this is WeChat conversation state, not per-message read
receipts or agent consumption. Reading does not mark messages as read.

Extract exports only already-local content. Its response includes `file_id`,
`expires_at`, and an authenticated `download_url`; it accepts no output path.
`GET /api/integrations/wechat/:machine/files/:file_id` requires the same authenticated
principal that exported it, plus current machine permission. Files are mode 0600,
expire after one hour, and are swept within 30 seconds or on access. Handles are
invalid after daemon restart; original media is never deleted. Maximum 32 retained
exports and 256 MiB per exported file. Missing/unsupported local media preserves
`exported:false`; network downloads and GUI clicks are not performed.

Each daemon permits one wx-cli query at a time; overlap returns `WOC_QUERY_BUSY`
immediately, not a queued task or lock wait. This is a bounded worker guard unrelated
to the desktop write lock. Query timeout is 90 seconds. No generic shell, init,
key refresh, consumer cursor, interface is exposed by the data-reading path. The optional UI API is separate below.

## MCP notifications

Install the pinned adapter dependency with `npm ci --ignore-scripts` in
`integrations/woc-mcp`. The launch command and existing private client configuration
are unchanged. `woc_wechat_*` tools use the contract above plus `machine_id`.

Resource `wechat://<machine>/messages` reads recent sessions. Supporting clients
subscribe using standard MCP resources subscriptions and receive
`notifications/resources/updated` with the URI. Only while subscribed, the MCP
adapter polls the authenticated gateway `revision` endpoint (default five seconds;
private client config `notificationIntervalMs` accepts 1000..300000).

`revision` is an opaque hash of current main-database file metadata. It is a change
hint, not a message ID/event sequence or a guarantee that every change is a new
message. It may also change after unrelated database updates. WAL-only messages can
remain invisible until checkpoint; no fixed notification latency is promised.
There is no event queue, replay, durable subscription, consumer state, webhook, or
automatic Agent invocation. Clients re-query on notification/reconnect and maintain
their own progress. Notifications use the existing MCP transport, with no new
listening port on the client. ACL/authentication is rechecked on every poll.

## Install and lifecycle

On the Docker host, run `install.py --help`. The installer requires the exact running
container, machine ID, account directory, already-verified private vault, verified
Linux wx binary, and panel secret directory. It verifies every key against local DB
headers without memory scanning, creates an account-local private key copy, and
adds only a supervised `woc-read` process under the container's existing `abc` user.
The source external vault remains unchanged. Normal operation needs no ptrace or
additional capabilities. Keys must be provisioned/updated explicitly by maintenance;
ordinary query failures never trigger scans.

Persistent files are under `/config/woc-read`: `config.json`, `server.py`, `bin/wx`,
`wx-home` (including private decrypted caches), `private` (keys and service token),
and `exports`. Directories are 0700. Database and media source directories must be
readable by the desktop user. Preserve the real account directory's basename and
the existing `.xwechat/net/kvcomm/key_*.statistic` filenames for offline Linux image
key derivation; alternatively configure `WX_IMAGE_KVCOMM_DIR` in the service
environment. Image conversion requires the application's existing ffmpeg.

The installer saves available kvcomm **filenames only** in
`private/image-kvcomm`; the service points `WX_IMAGE_KVCOMM_DIR` there. WeChat can
remove the original transient filenames during normal operation. An optional
`--image-kvcomm` accepts an existing private saved-name directory when provisioning;
no process reads, brute force or file-content extraction occurs. These names are
private derivation material and must not be committed or logged. wx-cli still
validates candidates against local encrypted images, and also checks live sources.

`/custom-cont-init.d/09-woc-read` creates `/run/service/woc-read` and asks the existing
s6 supervisor to scan it. Installation does not restart X, WeChat, Cua or the
container. Container restart executes the initializer again. Container **recreation**
must use the optional `deploy/read-daemon/Dockerfile` layer, which packages that
initializer and does nothing on desktops without `/config/woc-read/config.json`.
Do not recreate an enrolled container from an older image that lacks this layer.

The panel reads `WOC_READ_TARGETS_FILE`, an admin-owned JSON map:

```json
{"MACHINE_ID":{"url":"http://INSTANCE_CONTAINER:3212","tokenFile":"/run/secrets/woc-read/MACHINE_ID.token"}}
```

Mount that secret directory read-only; publish no daemon port. The unified compose
adds this optional route map to the existing panel. No second console is required.
An unconfigured instance returns `WOC_READ_NOT_CONFIGURED` without altering its UI.

For code/binary maintenance, stop only `s6-svc -d /run/service/woc-read`, then stop
that account's wx daemon using its explicit `WX_CLI_HOME` and desktop UID. Replace
the packaged `/opt/woc-read/server.py`, persistent service copy and binary,
preserving private directories and ownership; start
with `s6-svc -u /run/service/woc-read`. Re-query after restart. To disable, remove its
entry from the panel route map and stop the service; retain keys/data for rollback.

## Validation commands

```sh
cd services/woc-daemon && python3 -m unittest -v
cd ../../panel/server && npm run test:read && npm run test:control && npx tsc --noEmit
cd ../../integrations/woc-mcp && npm test
```

`acceptance.mjs PRIVATE_CLIENT_CONFIG MACHINE_ID PRIVATE_REPORT` exercises a real
SDK MCP client through the gateway and daemon against existing account samples.
Reports contain counts/types/file digests, not names, messages, keys, attachment
handles or download URLs. A notification can be deliberately triggered only against
the disposable snapshot via `WOC_TEST_SNAPSHOT_DB`, never by touching the original DB.
Actual MCP notification reception and automatic model wakeup are separate claims;
this service implements the former and provides no model scheduler.

## Optional WeChat UI adapter

Set `ui.enabled: true` explicitly in the private daemon configuration. Defaults
remain false. `ui.display` and `ui.bus` select the existing X display and AT-SPI
bus (see config.example.json). The adapter requires the desktop user's accessible
WeChat process, Python dbus, xdotool, xclip and the existing WOC input fence. It
does not launch/restart WeChat, inject code, or read process memory.

Package `server.py`, `ui_service.py`, and `wechat_ui.py` together in `/opt/woc-read`
and the persistent `/config/woc-read` copy. The updated installer and initializer
handle these files. Only restart the `woc-read` s6 service for a code update; there
is no need to restart the account or container. The optional image layer packages
the modules but never embeds an account, credential or enabled private config.

UI requests share `/api/integrations/wechat/:machine/:operation` and the same
internal daemon port 3212. The gateway checks the existing GUI write lock before
forwarding mutations with its trusted admission epoch. The daemon never calls
back, acquires a lock or fixes a missing prerequisite. Client scripts orchestrate.
Do not expose the internal daemon port or its service credential to clients.

`ui_state` and `ui_request_status` are observations. `navigate`, `ui_search`,
`open_item`, `fill_text`, and `send_draft` are writes. Each local UI worker is
bounded to five seconds and serialized without a waiting queue. The input fence
drains an admitted operation before control handover; it is not another GUI
ownership lock. UI references are caller-bound and expire after 60 seconds.

Send receipts live in `private/ui/requests.sqlite` (0600). They survive service
restart, retain up to 1024 entries for seven days, and distinguish known
non-execution from partial/unknown results. Preserve this file during maintenance
to keep duplicate protection. A receipt records local execution, not delivery.
Same request ID with changed arguments is rejected. No automatic send retries.

See [UI acceptance](../../doc/dev/WOC-WeChat-UI-验收.md) for page coverage, current
image digests, actual sends and rollback.
