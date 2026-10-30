---
name: woc-control
description: Coordinate GUI control of WOC managed computers using the WOC write lock together with the original cua-spaces tools. Use for WOC desktop operations, lock errors, and handing control back to a person.
---

# WOC desktop control

Use `woc_machines_list` to map a machine ID to its original Cua endpoint. Use the original `cua-spaces` skill and Cua tools for observing and operating it; WOC does not replace those tools.

- Screenshots, current UI observations and queries need no write lock. They do not keep a lock alive.
- Before GUI writes (including clicks, typing, scrolling, switching/launching apps), call `woc_lock_acquire(machine_id)`. Continue only when the returned state says `mine: true`; save its `lock_id`.
- Observe again after acquisition: a human may have changed the desktop. Use original Cua calls with unchanged connection credentials.
- Release with `woc_lock_release(machine_id, lock_id)` when finished or awaiting a long external decision. The server also releases after the reported idle timeout without GUI writes.
- On `WOC_LOCK_REQUIRED` or `WOC_LOCK_EXPIRED`, acquire, observe, then continue. On `WOC_LOCK_BUSY`, stop writing and report the current holder; do not poll acquire indefinitely. Web users can request control from the current holder; only administrators can explicitly force takeover.
- On `WOC_ACTION_UNCERTAIN`, verify the result; do not blindly repeat a click or send operation. `WOC_CONTROL_BLOCKED` needs status/recovery, not repeated input.

The Cua and WOC connections must be configured for the same authenticated client. A shared Cua credential is one client: run its GUI tasks serially. Do not supply another client ID or change credentials to bypass a lock.

Remote coding-agent and process/command APIs retain native behavior in this version; these calls neither acquire nor renew nor release the desktop lock. Do not use this exception to bypass a rejected GUI action.

Configured machines expose `woc_wechat_health`, `sessions`, `unread`, `contacts`,
`groups`, `members`, `history`, `search`, `attachments` and `extract` (all with the
`woc_wechat_` prefix). These read local data and never need a GUI write lock. Prefer
exact chat usernames from contacts/groups; query recent N messages and maintain
your own processing progress. WeChat unread counts are conversation-level, not
agent acknowledgments. Preserve checkpoint/freshness and missing-key warnings.

`extract` only exports locally available attachments and returns an authenticated,
temporary download URL. Use the same client credential through a trusted downloader;
never print credentials or put them into URLs. Missing media does not authorize UI
clicks, external downloads or key scans. Unsupported sticker cache remains unsupported.

Clients supporting MCP resources may subscribe to `wechat://MACHINE_ID/messages`.
An update is a hint to re-query, not an individual message or a model wakeup. There
is no offline replay; re-query after reconnect. A busy local query returns immediately
and may be retried later without taking any desktop lock.
