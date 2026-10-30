# woc-trigger

Independent automation daemon. Runs beside Paseo in the trusted, non-GUI Agent container; no Docker socket, GUI lock manager, business workflow engine, or Paseo schedule changes.

Node >=22.13 is required for built-in SQLite. `npm ci --omit=dev --ignore-scripts` installs pinned MCP SDK and Cron parser. Start with `node src/server.mjs /private/config.json`. Production setup: `node src/configure.mjs` inside the Agent container registers a separate WOC identity and creates `/state/automation/config.json` without printing credentials. Setup is idempotent and preserves an existing operator config.

```json
{
  "host": "127.0.0.1",
  "port": 6771,
  "stateDir": "/state/automation",
  "workspace": "/workspace/woc",
  "wocClientConfig": "/state/automation/client.json",
  "connections": {
    "woc": {
      "command": "node",
      "args": ["/opt/woc/integrations/woc-mcp/server.mjs", "/state/automation/client.json"]
    }
  }
}
```

The management Bearer token is generated in `stateDir/admin.token` (0600). Browser traffic follows WOC admin session → panel proxy → authenticated Paseo bridge → loopback service. Public POST Webhooks use a separate per-trigger token, returned once and stored only as SHA-256. No token goes in URLs. Other MCP connections are operator-controlled stdio configurations, never commands from notification input.

## Contract

- `GET /health`, `/catalog`, `/agents`
- `GET/POST /triggers`, `PUT/DELETE /triggers/:id`
- `POST /triggers/:id/run` — asynchronous manual run, even when disabled
- `GET /runs?trigger_id=...`, `/runs/:id`
- `POST /agent-tasks` — `{action, idempotency_key?}`, used by script helper
- `POST /hooks/:id` — separate Webhook token, JSON input, enabled trigger only

Trigger configuration and CLI examples are in [woc-automation](../../integrations/skills/woc-automation/SKILL.md). Validation is centralized in `src/contracts.mjs`. There is no custom event-cursor protocol: scripts own application deduplication.

Run lifecycle: `queued → running → succeeded/failed`; Agent actions first `waiting`, then persist `attempted` before sending, followed by `accepted`. A lost response or timeout after attempt becomes `unknown`, not an automatic retry. Success records a matching message, a subsequent assistant response, and idle observation; it does not certify that the Agent completed the requested business effect. Client disconnect/timeout never cancels an already-running Agent task. Busy targets wait; a dedicated automation conversation avoids races with simultaneous human tasks (Paseo has no atomic idle-only send).

One trigger runs serially; at most four actions execute globally. MCP notifications coalesce to one pending check and reconnect schedules a fresh check. Interval/Cron skip overlapping and missed occurrences. Webhooks keep each input. Disabling cancels queued runs; editing/deleting during a running action returns 409. On daemon restart, queued work survives, in-flight actions become interrupted and are not replayed. There is no exactly-once delivery guarantee.

## Bounds

200 triggers; 32 pending runs/trigger and 256 total; JSON input <=64 KiB; log tail <=64 KiB/run; action timeout 1..3600s. Completed history is retained for seven days or the newest 1000 records (whichever is smaller). Idempotency keys share that retention. Scripts receive `WOC_TRIGGER_STATE_DIR`; a 16 MiB watchdog checks before and during execution, and deleted-trigger state is reclaimed within a minute. This is an operational limit, not an OS security boundary or instantaneous filesystem quota. The shared workspace is user-owned and follows the Agent workspace retention policy.

Commands use spawn without a shell. JSON input goes to stdin. Timeout terminates the process group. Private execution logs and event inputs are only exposed to authenticated admins; script authors must not print secrets or unnecessary chat history.

## WeChat example

`examples/wechat-check.py` queries recent-N messages via the existing WOC gateway; it never switches chats, reads process memory, or clicks the GUI. First execution establishes a baseline. Later executions ignore outgoing private messages, deduplicate by machine/chat/time/type/content identity, and queue an Agent task. Groups require an exact sender username to avoid self-reply loops. A durable pending batch reuses its key after an uncertain submit; accepted queueing advances the local cursor. Later Agent failure is reviewed in run history, not automatically resent.

The existing WOC MCP resource is a **database-file checkpoint change hint**, not a per-message stream or guaranteed sub-minute delivery. A recent-N window can miss older messages after a long outage; no overlap emits a warning. `has_unread` is WeChat's state and is not the Agent's processing cursor. See the system architecture document for GUI lock rules.

## Tests

```sh
npm test
python3 -m unittest discover -s test -p 'test_*.py'
```

Tests include real stdio subscriptions/reconnect, queue recovery, auth separation, process timeout, source input handling, matched Agent receipt evidence, and WeChat baseline/deduplication. Real deployment acceptance is recorded separately in `doc/dev/WOC-Agent-会话关联与自动化.md`.
