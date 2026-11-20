# Mobile gateway and multi-host engineering contracts

**Date:** 13 November 2026
**Status:** Proposed. Contracts 2 and 3 need agreement from the remote-runtime owner before code depends on them.
**Plan:** [Reliable mobile access to desktop and VPS](../plans/2026-11-13-mobile-remote-access-plan.md), phases 2, 3 and 6.

These contracts close the narrow engineering gaps left by the plan. They do not change its locked decisions: Rust serves the mobile entry point and forwards an allowlist; TypeScript keeps pairing authorization, providers, approvals, receipts and conversation storage. Tailscale is required on the phone and the host, and there is no public fallback.

## 1. Multiple hosts: per-origin credentials, credential-free host directory

A browser keeps `localStorage` per origin. When each host serves `/mobile/` on its own tailnet HTTPS name, the phone app for host A cannot read host B's storage, and the hosted `mobile.bigbud.app` origin is a third, separate store.

- **Credentials stay where they were issued.** Each origin stores only its own session for its own host. A session token is never copied, forwarded, embedded in a link or sent across origins or redirects.
- **Host directory.** An origin may keep a small list of other hosts the user chose to remember: display name, HTTPS origin, and the stable authority identity from the handshake (contract 3), once known. It holds no tokens, pairing secrets, drafts or cached conversation data. Switching hosts is plain top-level navigation to that host's `/mobile/`. If that origin has no valid session, the user pairs there.
- **No central sync.** There is no new service for syncing directories or sessions. Every directory is local and user-maintained; a stale entry fails safely with the destination's own diagnostics.
- **State namespacing.** Within one origin that holds sessions for several hosts (the hosted compatibility path), drafts, pending command IDs, replay cursors and query keys are keyed by authority identity. Switching hosts cancels old subscriptions, and late frames are dropped by authority check. The existing singleton session migrates into one entry only after the authority identity is confirmed.
- **Origin changes.** If a remembered host's origin changes, the user re-pairs or the authority identity must confirm the new origin. A display name match is never enough.

## 2. Gateway lifecycle reuses the existing owners

No new orchestrator.

| Deployment | Owner of the gateway process                                                                                                | Restart policy                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Desktop    | The desktop backend launcher that already supervises the TS backend                                                         | At most five crash restarts in five minutes, then needs-repair; independent of backend delay policy |
| VPS        | The remote plan's account-scoped service supervisor (phase 7), as an optional child enabled only by separate mobile consent | At most five crash restarts in five minutes, then needs-repair                                      |

- **Stable endpoint.** The gateway listens on a fixed loopback port, or an owner-only Unix socket where Tailscale Serve supports one. That port is recorded beside the backend's lock and socket records, outside rotating generation directories. Tailscale Serve maps HTTPS 443 `/` to the gateway, not the backend, so a backend port change no longer breaks Serve.
- **Startup.** The process takes `--listen`, `--upstream` or `--upstream-unix`, `--external-origin`, `--assets-dir` and `--stdin-lifeline`. The upstream credential comes from `BIGBUD_MOBILE_GATEWAY_UPSTREAM_CREDENTIAL`, never argv. On success it prints one JSON readiness line with the bound address. If the supervisor closes stdin, the gateway stops.
- **Upstream attachment.** The upstream is fixed configuration only: an owner-only Unix socket where supported, otherwise authenticated loopback. The gateway refuses to start unless a credential is set, for every upstream; socket permission bits alone do not prove who created a socket. Before each Unix connection it checks that the path is a socket with no group or other permission bits. It sends the startup-generated credential in `x-bigbud-mobile-gateway`. The launcher passes the same secret to the backend in the same environment variable. When it is set, the backend's mobile routes (pairing, `/mobile-ws`, `/mobile` assets) reject any request without the matching header, using a constant-time comparison. An empty value fails closed. Unset keeps today's behaviour for hosts without the gateway. Windows named-pipe attachment is unverified; Windows uses authenticated loopback until a prototype proves otherwise.
- **Revocation.** Revoking or expiring a mobile session, or turning mobile remote control off, now closes that session's open sockets immediately; it no longer waits for the next upgrade. The backend's own close frames pass through the gateway to the phone unchanged. If the backend vanishes, the phone gets 1013 (try again).
- **Updates.** Replacing the gateway or its assets may drop mobile sockets. Clients reconnect and reconcile through the existing uncertain-command path. The gateway holds no queue and never replays a request.

## 3. Narrow mobile handshake exposure

The remote plan's pre-command descriptor stays private. Through the gateway, mobile gets a reduced projection at `GET /api/mobile/handshake`:

- stable host/backend authority identity
- backend version
- mobile RPC revision
- `mobileEnabled` flag

No capability list, provider inventory, paths or account details leave the tailnet surface. The route is added to the gateway allowlist only once the TypeScript projection exists. The descriptor type belongs to the remote-runtime owner's contracts; mobile consumes it only through this projection.

## 4. Signed, optional gateway and assets

- The gateway binary and the mobile asset bundle are separate optional artifacts. A host without mobile consent never downloads or runs them.
- Both are signed and staged through the same artifact and CAS path as the remote runtime, with explicit compatibility: gateway version, mobile asset version, and the minimum mobile RPC revision.
- Rolling back the gateway or assets never rolls back the conversation database.
- Until signing and lifecycle exist (plan phase 6), the gateway is a development prototype and is not shipped.

## Gateway evidence, 13 November 2026

The first std-only prototype was replaced on maintained libraries:

- hyper 1.x, HTTP/1 only
- tokio, hyper-util, http-body-util, futures-util and bytes
- tokio-tungstenite 0.29, handshake only, with no TLS. 0.30 was dropped because its sha1 0.11 duplicated the workspace's digest 0.10 crates.

The supervisor approved these. Default features are off, and the closure is MIT or MIT/Apache. They are pinned in the crate's own manifest because only this crate uses them. The crate is a root workspace member; adding it changed no existing `Cargo.lock` entry and added no duplicate crate on any target. WebSocket messages are relayed as opaque text or binary; the gateway never decodes RPC.

### Message size budget

| Envelope                 | Size                                      | Source                                                        |
| ------------------------ | ----------------------------------------- | ------------------------------------------------------------- |
| Recovery event batches   | at most 256 KiB                           | `MOBILE_RECOVERY_MAX_BATCH_BYTES`                             |
| Thread-detail pages      | 512 KiB text budget, up to 200 activities | `THREAD_DETAIL_PAGE_TEXT_BUDGET`                              |
| Recovery capture         | 4 MiB                                     | `MOBILE_RECOVERY_CAPTURE_MAX_BYTES`                           |
| Mobile baseline snapshot | 3 MiB serialized payload budget           | `MOBILE_BASELINE_MAX_BYTES`; leaves room for the RPC envelope |

- The backend-to-phone cap is 4 MiB, matching the plan's initial budget and the recovery capture.
- The server now bounds the baseline before returning it: remove older selected-thread messages, then shorten non-streaming summary previews. Pending approvals/questions are preserved. If it still cannot fit, return a typed mobile error rather than triggering a repeating oversized-socket reconnect. The gateway retains its 4 MiB transport cap.
- **Recorded handoff evidence:** the oversized-record worker reports a 3,138,004-byte degraded baseline and 180-byte RPC envelope overhead, leaving approximately 1 MiB below the gateway cap. The combined P4 review remains in progress; this is not real-account measurement. Baseline sizes on real data still require measurement before release, with live-database permission still pending.
- Phone-to-backend messages are capped at 1 MiB, including fragmented messages.

### Retained memory

- Each direction holds at most one message in flight. tungstenite write buffers are capped at one maximum message plus 256 KiB.
- **Process-wide admission:** every relayed message must take its byte count from a 32 MiB budget before it is written, and returns it once written. A message not admitted and written within the 30 s write deadline closes its connection.
- **Bound:** retained memory is about 16 connections × the reassembly buffers (at most twice 1 MiB inbound plus twice 4 MiB outbound), plus the 32 MiB admission budget. That is under 200 MiB.
- **Measured, macOS release build:**
  - 16 WebSockets each echoing 20 messages of about 1 MiB: 2.3 MiB idle, 72 MiB peak.
  - 16 phones that never read, with the backend pushing 4 MiB messages: 134 MiB peak, within the bound.
  - These figures come from an ad hoc local harness that is not checked in. The harness for the second case only partly stalled its clients. The authoritative stalled-reader check is the Rust test proving that relays stuck at the admission cap release their backends and return the budget.

### Other limits

- HTTP headers: 16 KiB, with a 10 s read deadline.
- Pairing bodies: 64 KiB requests and 256 KiB responses. Collecting the request body has a 10 s deadline, then the forwarded request has 15 s, so about 25 s in total.
- Pairing exchange attempts: 10 per minute per pairing ID and 120 per minute overall, with at most 256 IDs tracked. Attempts on other IDs do not use up a pairing's own allowance, but any tailnet peer can still fill the global window and block all pairing for up to a minute. That is accepted: only devices already authorized on the tailnet can reach the gateway.
- WebSocket idle timeout: 120 s.
- Connections: 16; a non-upgraded connection is closed after 120 s.
- One request per connection: every non-101 response carries `Connection: close`, so a 101 keeps a clean `Connection: Upgrade`.
- Upgrade requests that include `Connection: close` are rejected; otherwise hyper would rewrite the 101.

### Handshakes and close codes

- **Phone upgrade:** must be HTTP/1.1 with Upgrade and Connection tokens, version 13, exactly one well-formed key and no body.
- **Backend leg:** uses a fresh key. tungstenite verifies `Sec-WebSocket-Accept`, and the gateway rejects extensions it did not request. A backend 4xx is relayed as plain HTTP, a handshake timeout becomes 504, and anything else becomes 502.
- **Close frames:** backend close frames, code and reason, pass through to the phone. If the backend disappears, the phone gets 1013 (try again).

### Revocation and expiry

- **Watching:** an open socket watches its own session with `watchSessionEnd`. The watcher subscribes before re-reading the session file. Only an explicit `revokedAt` (or a revocation this process recorded in memory, in case cleanup already deleted the record), the expiry time, or mobile remote control being turned off ends the session; an unreadable file does not. The off check follows the settings change stream, with a re-read every 5 s in case the change landed before the stream subscribed.
- **Atomic writes:** session and pairing files are written to a temporary file and renamed, so readers never see a truncated record.
- **No lost updates:** every read-modify-write of those files (validation stamping `lastUsedAt`, revocation, pairing exchange, cleanup) runs under one store lock. Without it, a validation racing a revocation could write the session back un-revoked, and one pairing secret could be exchanged twice; regression tests reproduce both without the lock. Cleanup of expired records runs at most once a minute.
- **Closing the socket:**
  - On revocation or expiry the backend closes the socket with 4401 and the reason `unauthorized: mobile session revoked` (or `expired`).
  - The phone already treats that close as "pair again", not as a retryable network drop.
  - When mobile remote control is turned off, the close is 4503 with the reason `mobile remote control was turned off on this host`. That is not an authorization close: the phone keeps its pairing, shows "Mobile access is off on the desktop", and keeps its usual bounded retries. If those run out before access is back on, the user taps Retry or reopens the app; nothing reconnects indefinitely.
  - A rejection at upgrade time stays an HTTP 401, which browsers cannot read.
- **Dispatch:** every mobile `dispatchCommand` re-checks the session first, so nothing dispatches after revocation, even in the moment before the close lands.
- **Not covered:** commands accepted before the revocation are not cancelled.
- **CORS preflight:** the backend's global CORS middleware answers pairing `OPTIONS` requests before the credential guard runs. The response is static and reveals no state; this is accepted and recorded here.

### Checks

All run on the pinned toolchain 1.95.0, in the root workspace:

- **macOS arm64:** rustfmt, clippy `-D warnings`, and 25 unit plus 20 integration tests. The release binary is about 1.9 MiB, unstripped.
- **Linux arm64** (`rust:1.95-bookworm` glibc and `rust:1.95-alpine` musl): the same clippy and tests pass.
- **Windows x86_64:** clippy `-D warnings` for all targets passes. It found and fixed an irrefutable pattern.
- **x86_64 Linux** (`rust:1.95-bookworm` amd64, emulated on Apple silicon): the same clippy and tests pass. A native x86_64 host has not been used.
- Windows execution is not run; no Windows host is available.

### Integration tests

- **Routes:** the allowlist, including encoded traversal, absolute-form targets and `/ws`.
- **Headers:** forged forwarding, identity and hop-by-hop headers stripped in both directions.
- **Framing:**
  - chunked, duplicate, signed and oversized `Content-Length`
  - oversized and unfinished headers
  - one request per connection, with a pipelined second request never forwarded
- **Handshakes:** malformed phone upgrades rejected; a backend 401 relayed as 401. A wrong backend Accept, a missing backend Upgrade, or a non-HTTP backend each fail closed with 502.
- **Relay:**
  - opaque relay of a 900 KB message
  - 1009 for a 1 MiB + 1 message, whole or fragmented, with nothing reaching the backend
  - the outbound cap
  - a phone that stops reading
  - stalled readers at the admission cap, releasing their backends and returning the budget
  - backend loss closing with 1013
  - backend close code and reason (4401 "revoked") passed through
  - idle close; shutdown closing with 1012
- **Limits:** 503 past the connection cap; the pairing rate limit; 502 when no backend is running.
- **Configuration:** the credential is required for every upstream, `Debug` output redacts it, and group-accessible Unix sockets are refused.

### End to end with an isolated backend

The test `apps/server/src/server.mobile.gateway.test.ts` runs with `BIGBUD_MOBILE_GATEWAY_BIN`, against temporary state and no live account. It covers:

- pairing status and exchange through the gateway, with the exchange returning the `wss://` external origin
- a WebSocket RPC snapshot
- direct and forged-credential backend requests refused with 403
- a reused pairing secret refused with 401
- revocation closing the open socket with 4401, and new connections then refused

Server tests separately cover dispatch refused after revocation, the session watcher (revoked, already revoked, expired, unreadable file) and the credential guard.

### Live parity

Read-only probes against the running local backend: an unknown pairing ID gives 404, a preflight 204 with CORS headers, a bad-token upgrade 401, and `/ws` 404 at the gateway.

### Linux backend end to end

The gateway end-to-end and restart tests (`apps/server/src/server.mobile.gateway*.test.ts`) pass against a Linux backend:

- a gateway built in `rust:1.95-bookworm`
- a fresh `bun install --frozen-lockfile` in `node:25-bookworm`, on a `/tmp` copy of the tree
- both tests: 2 of 2 pass
- arm64 only; native x86_64 has not been run

### Latency (synthetic)

These are synthetic loopback measurements on a loaded macOS development host: a Bun echo backend, with and without the release gateway in front. They say nothing about phone or network latency.

| Path                   | Gateway overhead                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------- |
| WebSocket echo, 200 B  | none measurable (p50 about 0.1 ms either way)                                       |
| WebSocket echo, 64 KiB | about +0.16 ms at p50                                                               |
| Pairing GET            | about +0.2 to 1 ms at p50; p99 about 10 ms. Each GET opens a new backend connection |

### Host checklist (plan phase 1)

Desktop Settings → Mobile remote control shows a staged checklist built from the existing status:

1. installed
2. running
3. online in the tailnet
4. tailnet name
5. Serve → this backend
6. a final step that can only be checked on the phone

Steps after the first failure read "not checked". A full pass is local configuration evidence only. The phone retest procedure is in [the validation note](../validation/2026-11-13-mobile-phone-retest.md).

### Not yet shown

- the phone path over cellular (procedure ready, not run)
- Windows execution; clippy is not runtime evidence, and no waiver has been granted
- a native x86_64 host
- production supervisor integration, waiting for the remote lifecycle and descriptor contracts
- Tailscale Serve pointed at the gateway

## Existing-host task inventory for P3 integration

Source inspection on 14 November: `packages/contracts/src/server/rpc.mobile.ts`, `apps/server/src/ws/ws.mobile.ts`, and `apps/mobile-web/src/screens/MobileThread.commands.ts`. This is an inventory of the existing surface, not production VPS enablement or permission to expand the gateway.

| Task                                                              | Existing interface                                                                    | Session scope for mutation                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Start draft-thread turn                                           | `thread.turn.start` via dispatchCommand                                               | thread-control                                              |
| Send in existing thread                                           | `thread.message.submit` via dispatchCommand                                           | thread-control                                              |
| Stop running turn                                                 | `thread.turn.interrupt` via dispatchCommand                                           | thread-control                                              |
| Accept/reject approval                                            | `thread.approval.respond` via dispatchCommand                                         | approve-only or thread-control                              |
| Answer provider question                                          | `thread.user-input.respond` via dispatchCommand                                       | thread-control; approve-only does not grant free-form input |
| Archive thread                                                    | `thread.archive` via dispatchCommand                                                  | thread-control                                              |
| Browse and recover                                                | recovery baseline/subscribe, legacy getSnapshot/getMobileThread, replay/domain events | Reads require a valid mobile session                        |
| Reconcile uncertain command                                       | mobile recovery command outcome                                                       | Read; does not dispatch or mint a replacement command ID    |
| Inspect changes                                                   | getTurnDiff/getFullThreadDiff, gitRefreshStatus                                       | Read surface; no git mutation methods exposed               |
| Observe configuration/activity                                    | subscribeServerConfig/subscribeThinkingActivityDeltas                                 | Existing authenticated read subscriptions                   |
| Pair/enable remote authority                                      | No production mobile owner-socket setup yet                                           | Blocked on P7 runtime/explicit mobile consent               |
| Switch authorities                                                | No production host-session collection yet                                             | Blocked on P3 implementation; never transfer credentials    |
| Full RPC, terminal, filesystem mutation, arbitrary provider tools | Not members of MobileWsRpcGroup/global mobile command allowlist                       | Unavailable; do not add decorative UI or widen routes       |

The scope audit found that the existing dispatch route revalidated session tokens and enforced a global command allowlist but did not enforce the returned session's scope. Actual WebSocket regressions reproduced read-only interrupt/approval and approve-only interrupt dispatch (three failures before correction). The corrected guard checks the schema-decoded command type and current session scope before normalization, which itself can hydrate paths and persist attachments. Explicit permission denials carry the existing typed `unauthorized` code; the phone treats these as rejected rather than ambiguous delivery. Scope restrictions apply to existing hosts now; they must also be retained when P3 adds remote composition. Validation/review status for this correction is recorded in the full-plan ledger. No new RPC method or gateway route is introduced.

## Desktop lifecycle prototype, 14 November

The desktop owner now supervises the optional gateway through `mobileGatewayOwner`, `mobileGatewaySupervisor`, stable endpoint storage and a staged Serve adapter. This is unpackaged-development-only: `main.bootstrap` does not activate it in a packaged app. Explicit `BIGBUD_MOBILE_GATEWAY_BINARY` and `BIGBUD_MOBILE_GATEWAY_ASSETS_DIR` paths, an existing local mobile-enabled setting, and a previously recorded bigbud Serve mapping are required. No artifacts are downloaded or silently enabled. Missing binary/assets or denied consent cannot migrate Serve.

The endpoint record lives beside the server settings, outside rotating generations. A recorded port is reused, never silently rescanned when occupied. A fresh 32-byte owner-lifetime credential goes to the gateway environment and, only after readiness and Serve confirmation, the backend environment; it is never an argument or persisted secret. Backend process restarts reuse this owner credential, and a new desktop owner generates another. The child requires a matching bounded readiness line and an open stdin lifeline. The desktop backend launcher starts/stops it, including ownership handoff and awaited shutdown. Gateway crashes do not restart the backend. Five crash restarts within five minutes exhaust the budget even if each child briefly reports ready; explicit Enable remote access can retry. Existing backend restart policy was not changed.

Serve migration stages readiness first, replaces only the currently owned route, verifies it, then commits ownership. Failed confirmation attempts to restore the prior owned target and stops the candidate. Concurrent foreign routes are not overwritten during rollback; unconfirmed rollback is surfaced as needing attention. No live Serve mutation was performed during implementation. Code tests use fake commands and temporary ownership/settings files.

Evidence: `/tmp/mobile-gateway-desktop-final-tests.log` records eight focused files / 46 tests passing; `/tmp/mobile-gateway-desktop-final-types.log` is a successful configured desktop typecheck. Explicit format/lint/length checks cover the changed paths (largest 395 lines). `/tmp/mobile-gateway-supervisor-smoke.log` records the new supervisor launching the existing macOS ARM64 release gateway against a disposable HTTP fixture and asset directory: readiness, static assets, authenticated upstream, blocked full `/ws`, and lifeline shutdown pass. The initial smoke exposed omitted asset wiring, now corrected with mandatory validated assets. This is not signed packaging, real Serve execution, actual phone acceptance, native x64/Windows qualification, or production VPS readiness. Independent review is pending.
