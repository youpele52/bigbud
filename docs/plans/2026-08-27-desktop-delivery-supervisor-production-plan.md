# Desktop Delivery Supervisor Production Integration Plan

**Date:** 27 August, 2026
**Status:** Implemented locally; external native release gates pending
**Owner:** bigbud team

## Summary

Ship and run `bigbud-desktop-supervisor` as the authoritative orchestration
delivery coordinator for packaged desktop sessions. The TypeScript server owns
the sidecar and canonical event history; Electron owns the native artifact
lifecycle; the web client supplies end-to-end application acknowledgements.

Rust must self-heal across process and transport failures through restart,
reattachment, and canonical replay. A fenced TypeScript fallback is retained
only after bounded Rust recovery is exhausted, and a session never receives
events from both paths.

## Related Work

- `docs/decisions/2026-08-27-desktop-delivery-supervisor-authority.md` records the accepted authority and failure boundary.
- `docs/RUST_SYSTEMS_CORE.md` defines the wider TypeScript/Rust ownership model.
- `protocol/desktop-supervisor/v1.proto` defines the existing supervisor wire protocol.
- No verified note, Kanban card, issue, or pull request is linked to this plan.

## Problem

The Rust crate currently implements bounded event queues, in-flight batch
tracking, consumer generations, application acknowledgements, timeout recovery,
and a framed protobuf owner session. It is not connected to the desktop or
TypeScript runtime. No TypeScript codec or client exists, Electron does not
package or resolve the binary, and the WebSocket contract cannot carry an
application acknowledgement back from the consumer.

Consequently, packaged desktop sessions still deliver orchestration events
directly from `apps/server/src/ws/wsStreams.ts` to
`apps/web/src/routes/-__root.recovery.ts`. The supervisor cannot currently
protect renderer application, reconnect, or replay in a shipped application.

## Goals

- Make Rust the only orchestration delivery path for an attached, supported
  packaged desktop consumer.
- Preserve TypeScript/SQLite as the canonical domain authority.
- Acknowledge only after serialized web application and ownership reconciliation.
- Automatically recover supervisor crashes, broken framing, stalled ACKs, and
  WebSocket reconnects without duplicate delivery.
- Bound memory, queue size, retry count, retry duration, and diagnostic data.
- Package, sign, resolve, and smoke-test the native executable on every desktop target.
- Retain a deterministic emergency fallback without mid-session switchback.

## Non-Goals

- Moving orchestration event creation, canonical persistence, provider sessions,
  authorization, or product semantics into Rust.
- Routing supervisor frames through Electron IPC.
- Making the initial integration mandatory for standalone server distributions
  that cannot yet ship the native binary.
- Persisting a second canonical event log in the sidecar.
- Removing the TypeScript delivery implementation before the rollback window closes.
- Supporting silent per-batch bypass or concurrent Rust/TypeScript delivery.

## Implementation Evidence

- Shared Rust/TypeScript golden frames cover hello, attach, batch, ACK,
  ACK-accepted, recovery, protocol error, canonical batch digest, and truncated
  framing under `protocol/desktop-supervisor/fixtures/`.
- `apps/server/src/desktop-supervisor/` implements the owner process singleton,
  framed codec, strict handshake, stable cursor, higher-generation recovery,
  authoritative routing, shadow validation, and terminal fenced fallback.
- The web delivery queue applies batches and canonical ownership reconciliation
  before issuing an application ACK; concurrent canonical event flushing is
  serialized and accepted durable materialization outcomes remain
  `accepted-awaiting-event` while ownership is absent.
- Electron resolves `server/delivery-supervisor/bin`, passes the path directly
  to the server, and the artifact pipeline validates presence, executable mode,
  target, protocol handshake, timeout recovery, clean shutdown, SHA-256
  evidence, CycloneDX SBOM, and packaged discovery.
- Local evidence on 27 August 2026 includes the complete `bun run test` Turbo
  suite (all 9 tasks passed; server: 590 files and 2,337 tests passed, 11
  skipped), focused web/desktop/scripts suites, the Rust workspace suite, and
  the native handshake/recovery smoke. The final format, lint, typecheck, Rust,
  diff, and authored-file line-count gates passed after the implementation.

External release evidence is still required from native macOS arm64/x64,
Windows x64, and Linux x64 runners. This local implementation does not claim
that code signing, notarization, installer quarantine, suspend/resume, or
long-running platform soak gates passed.

The local unsigned macOS arm64 directory-artifact smoke reached Electron
packaging but could not complete because the host volume had only 1.4 GiB free
and failed with `ENOSPC` while copying an existing staged provider binary. The
native supervisor handshake, missing-ACK recovery, and clean-shutdown smoke did
complete locally; final packaged-artifact discovery remains a native-runner gate.

## Phases

### Phase 0: Freeze Invariants And Budgets

**Goal:** Turn the accepted authority boundary into executable constraints.

1. Add protocol fixtures shared conceptually across Rust and TypeScript for
   hello, attach, batch, ACK, recovery, error, and truncated-frame cases.
2. Define one batch identity algorithm and golden byte vectors. TypeScript must
   not independently invent a different digest representation.
3. Set initial explicit limits for frame bytes, consumers, queued events/bytes,
   in-flight events, ACK timeout, restart attempts, restart window, and stderr tail.
4. Define the routing states:

   ```text
   direct-unmanaged
       packaged attach
             |
             v
   supervisor-starting -> supervisor-live -> supervisor-recovering
                                  ^                   |
                                  |                   v
                                  +------------- recovered
                                                      |
                                                budget exhausted
                                                      v
                                              fallback-fenced
   ```

5. Specify that routing is selected once per subscription. Recovery retains
   Rust authority; only `fallback-fenced` permits direct delivery.

**Exit criteria:** Cross-language fixtures and state-transition tests encode
the authority, identity, bounds, and no-dual-delivery invariants.

### Phase 1: Build The Focused TypeScript Owner Client

**Goal:** Give the canonical server a reliable process and protocol boundary.

1. Add focused modules under `apps/server/src/desktop-supervisor/` for:
   - protocol domain types and protobuf codec;
   - length-prefixed frame reader/writer with exact EOF distinctions;
   - child-process lifecycle and bounded stderr diagnostics;
   - handshake/version compatibility;
   - consumer state and generation allocation;
   - restart policy, health, metrics, and typed errors.
2. Reuse the proven remote-agent wire primitives where semantics match, but do
   not couple supervisor state to workspace-agent operations.
3. Resolve the binary from `BIGBUD_DESKTOP_SUPERVISOR_BINARY`, then the packaged
   path supplied by Electron, then an explicit development target path.
4. Require `ClientHello`/`SupervisorHello` completion before attach or batches.
   Reject incompatible major versions; negotiate minor capabilities explicitly.
5. Make concurrent startup callers share one process promise. On process exit,
   reject pending requests once, retain the last verified application cursor,
   and enter the recovery state machine.
6. Expose health and lifecycle snapshots without event payloads, prompts,
   provider output, paths, credentials, or canonical message content.

**Exit criteria:** Focused server tests prove process startup, handshake,
framing, timeout, crash, concurrent startup, shutdown, and restart behavior.

### Phase 2: Add End-To-End Delivery And Application ACKs

**Goal:** Route one consumer through Rust without weakening web serialization.

1. Extend direct orchestration contract subpaths with a delivery envelope:
   consumer ID, consumer generation, server epoch, subscription generation,
   batch ID, and ordered canonical events.
2. Add an application-ACK RPC carrying exact batch identity, generation,
   received-through sequence, applied-through sequence, and application duration.
3. Assign one stable consumer identity per logical web client and increment its
   generation on every new subscription attachment. Reject stale generations.
4. Adapt `makeOrderedOrchestrationDomainEventStream` behind a focused delivery
   service. For supervisor-managed consumers it enqueues canonical batches in
   Rust and publishes only batches returned by Rust.
5. In the web recovery queue, acknowledge only after all batch events and any
   ownership reconciliation have completed. Failed or interrupted application
   sends no ACK and must be safe to replay.
6. Serialize ACK sending with event application. Ignore a late response from a
   fenced generation and treat an identity conflict as terminal corruption.
7. Keep replay and bounded recovery owned by the server, but route all recovered
   events back through Rust while the consumer remains supervisor-managed.

**Exit criteria:** Integration tests prove exact application ACK semantics,
replay after renderer interruption, stale-generation rejection, duplicate batch
idempotence, identity-conflict failure, and no event bypass.

### Phase 3: Implement Self-Healing And Fenced Fallback

**Goal:** Keep Rust authoritative through ordinary failures.

1. On ACK timeout, heartbeat loss, malformed output, broken pipe, or process
   exit, pause that consumer and fence the old process/consumer generation.
2. Restart with capped exponential backoff and jitter under both attempt and
   elapsed-time budgets. Never run two accepted supervisor processes.
3. Complete a fresh handshake, attach with a higher generation and the last
   verified application-acknowledged sequence, then request canonical replay.
4. If replay retention has a gap or cursor confidence is lost, run bounded
   catalog/detail recovery before returning to live delivery.
5. Buffer new canonical events only within the configured limits. On pressure,
   collapse to explicit recovery rather than dropping or unbounded growth.
6. After recovery budget exhaustion, terminate and fence Rust, reconcile the
   cursor, and enter TypeScript fallback for the rest of that subscription.
   Never switch back until a new WebSocket session attaches.
7. Surface factual lifecycle states—connecting, live, reconnecting, degraded,
   incompatible, and fallback—through existing connection UX and diagnostics.

**Exit criteria:** Fault-injection tests prove recovery across every failure
point, bounded resource use, a single active authority, and deterministic
fallback from the last verified application cursor.

### Phase 4: Package And Verify The Native Binary

**Goal:** Make the authoritative path available in real desktop artifacts.

1. Extend `scripts/lib/desktop-artifact/` to build and stage
   `bigbud-desktop-supervisor` for macOS arm64/x64, Windows x64, and Linux x64.
2. Stage it under a distinct immutable server resource directory, separate from
   the workspace agent, with the platform-native executable name and mode.
3. Extend desktop path resolution and `backendManager.ts` to pass
   `BIGBUD_DESKTOP_SUPERVISOR_BINARY` and packaged-runtime intent to the server.
4. Include the executable in macOS signing/notarization, Windows signing, Linux
   artifact verification, SHA-256 manifests, SBOM, and license review.
5. Add packaged smoke tests for binary presence, executable permission,
   handshake compatibility, clean EOF/shutdown, forced crash/restart, and no
   orphan process after app exit.
6. Keep `protoc-bin-vendored` only with the approval and rationale required by
   `crates/AGENTS.md`; otherwise use the repository-approved generation path.

**Exit criteria:** Every supported desktop artifact proves the binary can be
launched, handshaken, recovered, and cleaned up on its native runner.

### Phase 5: Authoritative Rollout And Cleanup

**Goal:** Enable the shipped Rust authority without an unsafe flag flip.

1. Add a development/CI shadow comparator that checks ordering, batch identity,
   recovery decisions, and sequence cursors while only the selected authority
   delivers to the web consumer.
2. Run soak and fault tests covering reconnect loops, renderer reloads, server
   restarts, queue pressure, slow application, suspend/resume, and app shutdown.
3. Enable authoritative Rust by default for packaged desktop only after Phase 4
   passes on all supported targets. Keep a startup-selected rollback gate.
4. Reject an enabled packaged launch when the binary is missing, unsigned,
   incompatible, or unhealthy; enter explicit degraded/fallback state rather
   than silently claiming supervisor authority.
5. After at least one stable release meets reliability budgets, remove shadow
   comparison and reassess the rollback gate. Preserve standalone-server direct
   delivery until its native distribution plan is implemented.
6. Replace prototype wording in contributor and release documentation with the
   accepted runtime boundary and troubleshooting procedure.

**Exit criteria:** Packaged desktop sessions use Rust authoritatively by default,
cross-platform release gates are green, and support can diagnose or recover a
failure without risking duplicate delivery.

## Risks And Decision Gates

- **Split authority:** Any direct publish while Rust is live can duplicate
  application. One delivery service must own route selection and enforce it.
- **False ACK:** ACKing on WebSocket receipt loses renderer failures. Only the
  serialized application queue may issue application ACKs.
- **Uncertain cursor:** Process or socket failure can race with ACK forwarding.
  Recovery uses the lower verified cursor and idempotent replay, never a guessed
  higher sequence.
- **Crash loops:** Restart policy needs independent attempt, elapsed-time, and
  process-count bounds before packaged enablement.
- **Protocol drift:** Golden fixtures and major/minor negotiation gate Rust and
  TypeScript changes together.
- **Cross-platform lifecycle:** Windows process trees, macOS signing/quarantine,
  Linux executable modes, and suspend/resume require native-runner evidence.
- **Payload exposure:** Diagnostics contain IDs, counters, durations, versions,
  and reason codes only; canonical payloads and user content stay excluded.

## Testing And Validation

Run focused suites during each phase, then the complete repository gates:

```sh
bun fmt
bun lint
bun typecheck
bun run test
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
```

Also require:

- Rust property/unit tests for framing, queue bounds, batch identity, stale
  generations, duplicate ACKs, timeouts, and recovery actions.
- Cross-language golden protobuf and frame fixtures.
- Server integration tests for process crashes, incompatible handshakes,
  replay gaps, ACK races, reconnect generations, and fallback fencing.
- Web tests for event arrival during ownership reconciliation, failed
  application, ACK ordering, reload, and duplicate replay.
- Packaged macOS, Windows, and Linux smoke tests and orphan-process checks.
- Long-running soak tests with bounded memory, CPU, handles, queues, and restart count.
- Final `git diff --check`, authored-file line-count audit (maximum 400), and
  explicit confirmation that no commit or push occurred without approval.

## Acceptance Criteria

- A supported packaged desktop session launches a compatible signed supervisor
  and routes every attached consumer batch through Rust.
- Rust remains the delivery authority through successful automatic restart,
  reconnect, reattach, replay, and bounded recovery.
- The web client ACKs only complete serialized application plus ownership reconciliation.
- Renderer, WebSocket, server-side client, and supervisor crashes recover without
  lost acknowledged events, duplicate visible application, or concurrent authorities.
- Queue overload and replay gaps produce explicit bounded recovery.
- Exhausted self-healing performs one fenced session-level fallback and never
  switches back mid-session.
- Electron exits without orphan supervisor processes on macOS, Windows, or Linux.
- Standalone server behavior remains unchanged unless an explicitly supported
  supervisor binary distribution is configured.
- All repository and native artifact gates pass, all touched authored files are
  at most 400 lines, whitespace checks pass, and no commit or push is made
  without fresh approval.

## Open Questions

None. Runtime ownership, initial release surface, authoritative rollout,
application-acknowledgement semantics, and recovery/fallback policy were resolved
before this plan was written.
