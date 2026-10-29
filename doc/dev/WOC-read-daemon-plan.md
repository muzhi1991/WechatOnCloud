# WOC read daemon, 2026-10-29

Approved scope: per-container service, wx-cli groups/query/local-media adapters,
existing gateway authentication and machine ACLs, WOC MCP tools and standard
resource-update notifications, isolated and real-data acceptance.

Status: implemented and deployed to the existing unified console and logged-in
WeChat instance. See [acceptance](WOC-read-daemon-acceptance.md) for actual results,
including the download-stream fix and the limits of notification reception.

No GUI writes, write-lock acquisition/renewal, new key scans, automatic network
media fetching, event queue/sequence/consumer offsets, or auto-replies. Existing
research files in this checkout are outside this implementation's commit.

## Interfaces

- `sessions`, `unread`, `contacts`, `groups`, `members`, `history`, `search`,
  `attachments`, `extract`: fixed wx-cli command adapters with JSON output.
- `health`: service readiness; `revision`: opaque current database-file metadata
  fingerprint for change hints only, never an event sequence or replay cursor.
- Exports use generated handles, caller-bound authorization and finite retention.
  Callers cannot choose filesystem paths. All requests are authenticated.
- Gateway routes under `/api/integrations/wechat/:machine/:operation` reuse
  configured clients and machine scope. Web sessions use existing instance ACLs.
- MCP resource `wechat://<machine>/messages`: read current recent sessions;
  subscribed connections compare revisions periodically and emit
  `notifications/resources/updated`. Reconnect requires a fresh read. No offline
  delivery, durable subscription or promise to wake a model.

## Delivery sequence

1. Verify standard MCP notifications with an actual SDK client and document host
   compatibility separately from protocol reception.
2. Add/test wx-cli local group inventory; check all required Rust targets.
3. Implement/test authenticated daemon, safe adapters, bounded export storage.
4. Add/test panel routes and MCP commands/subscriptions; regress existing locks.
5. Run new cap-dropped test containers with real account data mounted read-only;
   no login/session/container changes. Validate privacy, ACL, restart, failures,
   every query and available local media. Stage production service on the existing
   machine without restarting WeChat after the isolated deployment passes.
6. Document installed paths, operation, actual acceptance and remaining limits.
