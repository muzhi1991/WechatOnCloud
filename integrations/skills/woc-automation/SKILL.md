---
name: woc-automation
description: Configure and inspect WOC automation triggers (MCP resource changes, webhooks and schedules), their script or Agent actions, and run logs. Use when asked to automate or schedule tasks in WOC.
---

# WOC automation

Use the existing standalone trigger daemon. Do not start a private polling loop, edit its SQLite file, or modify Paseo schedules. The deployed CLI is:

```sh
node /opt/woc/services/woc-trigger/src/cli.mjs list
node /opt/woc/services/woc-trigger/src/cli.mjs agents
node /opt/woc/services/woc-trigger/src/cli.mjs create --file /workspace/woc/automation/trigger.json
node /opt/woc/services/woc-trigger/src/cli.mjs run TRIGGER_ID
node /opt/woc/services/woc-trigger/src/cli.mjs runs TRIGGER_ID
node /opt/woc/services/woc-trigger/src/cli.mjs log RUN_ID
node /opt/woc/services/woc-trigger/src/cli.mjs pause TRIGGER_ID
node /opt/woc/services/woc-trigger/src/cli.mjs resume TRIGGER_ID
```

Create disabled first, validate the script and input, then enable according to the user's authorization. Manual run really executes the action. Prefer a dedicated automation conversation; the existing Paseo API cannot atomically guarantee an idle target if a person sends a task concurrently. Agent delivery waits for idle; submitted and completed are different facts. Unknown/interrupted delivery must be inspected before repeating a message or GUI write.

Configuration has `name`, `enabled`, `source`, and `action`. Source:
- `{"type":"mcp","connection":"woc","uri":"wechat://MACHINE_ID/messages"}`
- `{"type":"webhook"}` — creation returns a one-time secret; keep it in a private file, not a transcript.
- `{"type":"interval","seconds":60}` or `{"type":"cron","expression":"0 9 * * *","timezone":"Asia/Shanghai"}`.

Action:
- `{"type":"script","command":"python3","args":["/workspace/woc/automation/check.py"],"cwd":"/workspace/woc","timeout_seconds":300}`.
- `{"type":"agent","agent_id":"EXACT_ID","message":"Authorized task","include_input":true,"timeout_seconds":1800}`.

Scripts read the event as JSON on stdin and use `WOC_TRIGGER_STATE_DIR` for bounded state (16 MiB). stdout/stderr are retained in bounded private run logs; never print credentials or raw private histories. Pass external content as JSON/files, never interpolate it into shell commands. Scripts can queue an Agent task through:

```sh
node /opt/woc/services/woc-trigger/src/cli.mjs agent send --agent EXACT_ID --message-file PRIVATE_TASK_FILE --key STABLE_BATCH_KEY
```

Webhook requests use POST JSON and `Authorization: Bearer SECRET`. MCP changes are hints; script checks recent data and owns deduplication. Reconnect triggers another check. No full-history or exactly-once guarantee. Same trigger runs serially; MCP changes coalesce, timers skip overlap/missed periods, webhook inputs remain separate. Failures are not automatically replayed.

WeChat template: `/opt/woc/services/woc-trigger/examples/wechat-check.py --machine ID --chat EXACT_USERNAME --agent AGENT_ID --instruction 'User-authorized policy'`. Resolve usernames using woc-wechat. The first run establishes a baseline without sending tasks. Groups require `--sender EXACT_USERNAME`; private chats ignore outgoing rows. Recent-N checks may miss messages outside the retained window. Do not treat WeChat unread as Agent progress. A read query does not acquire or renew a GUI lock. Any subsequent GUI action must use woc-control and existing skills; this daemon never acquires locks on the Agent's behalf.

Use `update ID --file FILE` to edit, `delete ID` to remove, and `health` to inspect source connectivity. New trusted MCP connection commands belong in the daemon's operator configuration, not notification payloads. State belongs to this shared trusted Agent environment, not an OS isolation boundary between conversations.
