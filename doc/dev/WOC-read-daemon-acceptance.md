# Read daemon acceptance, 2026-10-29

## Delivered

- Per-container Python service, supervised by existing s6 as desktop user `abc`.
- Existing WOC panel routes with managed-client or web-session machine ACLs;
  per-instance internal credential and caller-bound temporary media downloads.
- WOC MCP read tools, resource reads/subscriptions and resource-update notifications.
- wx-cli `groups` and service-account aggregation classification; own fork main
  commit `d4e9247` (no upstream PR).
- No GUI input, lock acquisition/renewal, sends, automatic key scans, remote media
  downloads, durable events/consumer offsets, webhook or model scheduler.

## Verification

| Check | Observed result |
| --- | --- |
| wx-cli Rust | macOS 149 passed / 1 root-only ignored; native Linux 132 passed / 1 ignored; macOS/Linux GNU/Windows MSVC checks pass |
| Daemon unit/integration | 5 tests: command allowlist, argument validation, unread flag, immediate busy error, private exports/TTL/ownership, HTTP auth, metadata-only revisions |
| Gateway | 2 tests: authentication, machine scope, forged principal ignored, revocation, download auth; 8 MiB HTTP/1.0 transfer to slow client |
| Existing regressions | control 25, Cua registry 4, lifecycle 3, desktop 4 pass; TypeScript check passes |
| Actual MCP SDK client | initialize, tools, resource listing/read, subscribe/update, unsubscribe, reconnect baseline, unauthorized machine rejection; no GUI-lock requests |
| Isolated real account | Read-only encrypted snapshot and original vault, independent PID namespace, no ptrace capability, internal network with no Internet egress |
| Real query results | 9 sessions, 33 contacts, 2 groups, 3 unread sessions; group member counts 4 and 7; selected chat has 25 messages spanning nine displayed types; search finds an existing sample |
| Real media downloads | image PNG 1,536,789 bytes; original voice 4,944 bytes; PDF 376,300 bytes; ordinary video 1,903,947 bytes. Counts/digests match the earlier CLI acceptance; downloads without credentials rejected |
| Sticker | Preserves `exported:false`, `unsupported_local_cache`; no CDN download |
| Notifications | Real SDK received update through gateway/daemon after changing **only disposable snapshot metadata**, then re-read successfully. No original message DB touched to generate an event |
| Restart/failure | Fresh install validates 20 keys; s6 restarts daemon; isolated container restart restores queries; restart invalidates export handles; unreachable upstream reports 503 and recovers |
| Production Mac client | Existing private WOC client credential queried actual installed service through the unified panel; all four local media types downloaded; resource subscription accepted |
| GUI control | After queries/downloads/subscription the lock remains free, inflight=0 |

A protocol notification reaching a client does not mean the host automatically
starts an Agent turn. Automatic wakeup has not been added or claimed. Production
subscription was tested without asking the user to send another message; no fixed
new-message delay is claimed. Main-database checkpoint limitations remain visible.

## Issues found and corrected

The production Node 22.23.4 bundled fetch/undici client asserted in `Parser.finish`
when an HTTP/1.0 file response closed under downstream backpressure. The first Mac
media test exposed it and the panel restarted twice. The issue was reproduced in an
isolated container with an 8 MiB synthetic response and a slow consumer. Download
forwarding now uses native Node HTTP streams; that regression and the original Mac
real-media path both pass. This was not a WeChat restart or a successful transfer.

WeChat removed its original transient kvcomm key filename between initial snapshot
and production tests. The already validated filename was retained privately, and
the installer now preserves available filenames (no contents) under the service's
private directory. wx-cli verifies derived candidates against encrypted images.
The final Mac image export succeeds without a process-memory scan or editing the
original WeChat kvcomm directory.

## Deployment

The existing unified console at port 36083 remains the sole daily entry. The
original logged-in WeChat instance has the additive read service on internal port
3212, with no published daemon port. Other instances report unconfigured until
explicitly provisioned. Their images/configurations are not silently changed.

- Panel: `local/woc-panel:read-v2`, image
  `sha256:3e3b2ba54dbf6d99b38a3b176ff4dc8b6b1ea3a1159a6d81ea9eb01ba5d9c2c6`.
- Optional new-container layer: `local/woc-cua:read-v1`, image
  `sha256:117a9f2b4f9c3ef4d4554de3026f1c6067d7953d06b7c2904f6f0db59ee58501`.
- Private route map/service credentials: host
  `/root/woc-cua-control/deploy/read-daemon/secrets/`.
- Persistent service files: instance `/config/woc-read/`.
- Original external vault is unchanged; the service has an account-local private
  verified copy. Only read-service processes were explicitly restarted.

Original WeChat, browser, full-desktop and preexisting Cua-worker container IDs,
StartedAt, images, privileged flag and added capabilities match their pre-deployment
records. Panel restarts can cause the existing control lifecycle to reinitialize
Cua input services; no claim is made that every Cua process retained its PID.

Private acceptance summaries and rollback configuration are kept on the host under
`/root/woc-read-private/`; the Mac summary is beside its existing private WOC client
configuration. They contain counts/types/digests, not keys or conversation bodies.
Disposable test containers, encrypted snapshots, kvcomm-name test copies, plaintext
test caches and temporary exports are removed after final verification. Production
keys, image derivation material and normal private caches remain available.

Usage and lifecycle: [read service](../../deploy/read-daemon/README.md).
