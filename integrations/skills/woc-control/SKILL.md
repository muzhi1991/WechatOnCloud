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
- On `WOC_LOCK_REQUIRED` or `WOC_LOCK_EXPIRED`, acquire, observe, then continue. On `WOC_LOCK_BUSY`, stop writing and report the current holder; do not poll acquire indefinitely. A person can explicitly take over.
- On `WOC_ACTION_UNCERTAIN`, verify the result; do not blindly repeat a click or send operation. `WOC_CONTROL_BLOCKED` needs status/recovery, not repeated input.

The Cua and WOC connections must be configured for the same authenticated client. A shared Cua credential is one client: run its GUI tasks serially. Do not supply another client ID or change credentials to bypass a lock.

Remote coding-agent and process/command APIs retain native behavior in this version; these calls neither acquire nor renew nor release the desktop lock. Do not use this exception to bypass a rejected GUI action. Message monitoring and business operations are not provided by this skill yet.
