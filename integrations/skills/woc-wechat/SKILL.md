---
name: woc-wechat
description: Read WeChat data and operate supported WeChat pages on WOC machines, including opening a person or group conversation and sending authorized text using the bundled client workflow.
---

# WeChat on WOC

Use this skill for WeChat-specific tasks. Use `woc-control` for the shared GUI lock rules and the original `cua-spaces` tools when an unfamiliar interface needs observation or decisions.

Resolve the target with `woc_wechat_sessions`, `contacts`, or `groups` and use its exact `username`. A database entry identifies the intended account; a matching UI name alone does not prove identity when multiple entries share that name.

For ordinary workflows run `scripts/wechat.py`; do not recreate its fixed steps with repeated model calls. It uses the existing WOC client JSON configuration (panelUrl/tokenFile), authenticated HTTP, explicit lock acquisition and release. Pass the same configuration as the WOC MCP, using `--config` or `WOC_CLIENT_CONFIG`. Never print credentials.

```sh
python3 scripts/wechat.py --config PRIVATE_CONFIG --machine MACHINE_ID state
python3 scripts/wechat.py --config PRIVATE_CONFIG --machine MACHINE_ID open-chat --chat EXACT_USERNAME --source sessions
python3 scripts/wechat.py --config PRIVATE_CONFIG --machine MACHINE_ID send-text --chat EXACT_USERNAME --source contacts --text-file PRIVATE_TEXT_FILE --request-id UNIQUE_REQUEST_ID
```

`--source sessions` is for conversations returned by wx-cli sessions; `contacts` is for contact inventory; `groups` is for group inventory. The script first opens an exact, currently visible local item if available. Otherwise it searches from the conversations page for sessions/groups, or from the contacts page for contacts. **Do not scroll conversation/contact lists one page at a time.** WeChat search mixes local contacts, groups, chat history and network suggestions; select only the matching local contact/group category. The script rejects ambiguous matches. File Transfer Assistant is the explicit supported system chat under the local “功能” category, not a contact or network suggestion.

The daemon provides small WeChat page operations; the script owns navigation/search/fill/send sequencing. It never automatically retries a send. Reuse the same request ID when checking an interrupted attempt; `ui_request_status` reports the stored receipt (seven-day retention). A completed input action is not proof the recipient received or read the message. The script reports UI and database verification separately.

Stop and return to Agent observation for unknown pages/dialogs, ambiguous identity, changed drafts, stale items, loss of control or unknown execution results. Use original Cua to resolve the specific prerequisite under the same lock rules, then call the appropriate workflow again. Do not overwrite another person's draft, acquire in a loop, bypass a rejected operation via shell, or resend because a checkpoint-only database query temporarily lacks the message.

Only send content authorized by the user's task to the intended recipient. A missing media file is a prerequisite error, not authorization to download or send it. Complex historical-message navigation remains an Agent/Cua workflow.

The script serializes workflows on this client by machine. Other hosts using the same credential must also serialize their work; use distinct client identities for independent concurrent agents.
