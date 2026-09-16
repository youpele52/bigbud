# Remote-agent staged updates with isolated, generation-pinned runtimes

## 1. Metadata

- **Status:** Ready for implementation — parent independent review completed (`ses_f872b2eb6ffexznIco6PpHfj4X`); mandatory corrections below are authoritative. No additional approval/delegation gate.
- **Created:** 2026-09-07 00:26:09 +02:00
- **Last modified:** 2026-09-07 03:38:00 +02:00
- **Owner:** implementing agent; parent owns final independent implementation review.
- **Project root:** `/Users/youpele/DevWorld/bigbud`
- **Inspected branch / HEAD:** `main` / `1d02e44cd090cc0e2bce25a2cca1a88442e4873e` (current v0.2.207).
- **Legacy source:** v0.2.205 / `461b7865cd28bb2570d9f580405fa53daee7b51f`.
- **Related work:** user-approved coexistence design in the planning request; [local investigation](remote-agent-0.2.205-upgrade.md); [accepted native boundary](../decisions/2026-08-22-rust-remote-workspace-agent-boundary.md). No issue, note, or Kanban ID supplied or identified; none invented.
- **Protected working document:** `docs/plan/remote-agent-0.2.205-upgrade.md` must NEVER be staged or committed, including forced staging. It is currently ignored. Do not rewrite it to remove historical evidence.
- **Permissions:** implement the complete agreed plan. No SSH/VPS access, staging, commits, pushes, tags, releases, production process actions, or broad worktree cleanup. Plans belong only in `docs/plan/` and must never be staged.

## 2. Goal and definition of done

### Summary and goals

Keep a compatible existing 0.2.205 connection serving while an authenticated candidate is downloaded and checked in its immutable version directory. Staging does not start a supervisor. A subsequent **fresh deliberate connection** activates an isolated candidate, verifies identity/protocol/readiness, and only then admits user work. Existing logical connections and every recovery/control operation remain bound to their original runtime.

### Acceptance criteria

1. Staging changes neither old runtime state nor old discovery links and does not launch any candidate supervisor/proxy/stateful stdio session. Stateless supported `--check` is allowed.
2. Compatible legacy access is usable despite not matching the newest artifact. Unsupported protocol/capabilities still fail before the affected operation; the version guard is replaced by validated compatibility, not deleted.
3. An explicit fresh-connection action is the only event consuming a pending update. Background health checks, credential unlocking, automatic transport recovery, retries, cancellation, reload recovery, and install completion do not consume it.
4. Fresh admission resolves one runtime descriptor, starts or reuses that runtime in private state, validates hello plus readiness, commits health/selection, and binds the logical connection before work can be sent.
5. A process/PTY/workspace/watch creation race cannot mix runtimes. Accepted or potentially sent work never migrates, silently resubmits to fallback, or retries merely because an attach says “unknown or expired.” Same-ID fault tests produce exactly one side effect.
6. Verified candidate startup/readiness failure before admission immediately selects a verified healthy fallback for that fresh connection. Accepted/unknown work on an unhealthy runtime remains pinned there; independent new connections may use fallback.
7. Retain the two most recently proven healthy distinct builds (latest and fallback), plus all pinned builds. Candidate staging does not occupy or evict a healthy slot. Cleanup may remove the third healthy build only when unreferenced.
8. Quarantine unhealthy builds from new admission before considering binary deletion. Network/SSH/authentication failures alone never establish binary ill health. Logs and retained operation data are preserved separately from binary cleanup.
9. Persist pending/current/health/retention and known owner/recovery routes across server restarts. Unknown legacy ownership remains conservatively pinned; do not claim to discover/import independent legacy sessions.
10. UI accurately distinguishes current connection, pending update, and healthy fallback, and shows concise typed failures rather than shell command dumps.
11. All validation gates below pass, including actual legacy Linux integration. All authored/materially edited source and test files are at most 400 lines.

## 3. Background and evidence

### Problem and confirmed findings

- `remoteAgentInstall.ts:87-108` already uses `bin/<version>/<sha256>/bigbud-remote-agent`, but `stateRoot` is globally `.bigbud/agent/state`. Its staging script currently creates/checks that old state directory unnecessarily.
- `remoteAgentInstallManager.ts:186-205` immediately invokes activation and returns the mutable active link. Its `verifyInstalledAgent` is a `--check`, not a live readiness handshake.
- `remoteAgentInstall.activation.ts` publishes `bin/current` before supervisor verification, stores pending state inside the shared state directory, and rolls links back on failures. `remoteAgentInstall.transaction.ts:66-101` prepares the new/old runtime through those links.
- `remoteAgentSupervisor.ts:15-16` hardcodes the old socket/log. Its normal proxy launcher invokes preparation, unsuitable for legacy reconnect or isolated runtime selection.
- `remoteAgentServerLayer.ts:95-108,128-136` rejects any artifact identity mismatch as upgrade-required. At line 262, installation closes the target pool.
- `remoteAgentConnectionPool.ts:33-57,72-83,105-115` keys lifecycle by target and reconnects by resolving the target again. `remoteAgentLifecycle.ts:64-72` detects epoch changes but records the newly observed epoch, permitting a later retry to forget the original expected epoch. Persist a fixed expected epoch instead.
- `remoteAgentProcessClient.ts:146-160` attaches after a failed send/acceptance and resubmits unknown/expired work once. “Unknown or expired” cannot establish nonacceptance, even in the same generation after retention expiration.
- `remoteAgentPtyAdapter.ts:40-44` separately resolves workspace and PTY clients; publication between the two can mix runtimes. `remoteAgentToolRunner.ts:56-63` already opens the workspace on the selected process connection: reuse this pattern.
- `useRemoteExecutionAccessGate.ts` verifies opportunistically and may call `onVerified` while checking is still pending (lines 162-170,256-267). UI verification is not a safe server admission fence.
- `Sidebar.projectAddActions.remote.ts:254-261` immediately submits a project after installation. `SidebarRemoteAgentInstallDialog.tsx` currently says upgrade is mandatory before use. Both must distinguish staged from ready.

### Actual legacy source verification performed for this plan

Read legacy `main.rs` and `session/mod.rs` via `git show`, without extracting or editing project files:

- Both versions support `BIGBUD_AGENT_STATE_DIR`; legacy recognizes `--check`, `--supervisor`, `--proxy`, and `--ephemeral`, but not `--prepare-supervisor`. Default CLI dispatch enters stateful stdio.
- Legacy hello advertises major-1 `diagnostic`, `workspace.files`, `workspace.search`, `workspace.write`, `workspace.watch`, `process.run`, `process.attach`, and `terminal.pty`. `agent_version` uses `CARGO_PKG_VERSION`; `--check` uses `BIGBUD_AGENT_BUILD_VERSION`. Both use the build-digest override.
- Diffs of legacy versus HEAD `common.proto`, `process.proto`, and `pty.proto` were empty. `v1.proto` adds resource-cleanup frames 100–107 in HEAD. Do not send candidate-only cleanup RPCs to legacy or equate missing optional cleanup capability with failure of supported old work.
- The investigation records check version 0.2.205/live version 0.1.0 and Linux aarch64 source-built fixture proof, not authentication of downloaded release bytes.

### Reproduction and confidence

The protected investigation records repeated network-disabled Linux aarch64 experiments: stale unmatched legacy journal acceptance causes candidate preparation exit 11; unknown legacy prepare rotates epoch; independent stdio mutates shared state despite activation flock and a frozen supervisor. Separate runtime roots preserve old process completion/reconnect. Sending the old ID to candidate gives unknown; resubmitting executes the command twice.

Confidence is high in the source-supported routing/shared-state hazards and isolation mechanism. The prior proof is wire-level, not a completed application integration trace. This planner did not rerun binaries, tests, containers, or remote commands. No production deployment diagnosis or published artifact certification is claimed.

## 4. Plan assumptions and engineering defaults

These are engineering defaults within the approved behavior, not requests for product approval:

- **Logical connection:** introduce an explicit server-owned connection ID bound to one runtime generation. Target-only consumers use the persisted current admission binding; creation resolves it once. Resource handles retain their own binding even after a later deliberate connection replaces the target's admission binding. A new chat/terminal alone is not an update trigger; the explicit “Connect new session” action is.
- **Generation versus build:** a build is version + artifact SHA + target triple; generation identifies a particular private state root and expected epoch. One normal managed runtime per build is enough; reuse its persisted descriptor across attempts. Never create a new empty root to make a failed recovery appear successful.
- **Retention ordering:** “most recent healthy” means monotonic first-successful-promotion sequence of distinct builds, not download time or last ping. Rechecking fallback never makes it newer than latest. Fewer than two healthy builds is valid; display absence of fallback honestly.
- **Ownership:** metadata coordinates cooperative current installers/clients using the same remote SSH account and canonical install root. Same-UID adversarial processes explicitly aimed at private roots are not sandboxed. Unknown legacy owners impose a permanent automatic-cleanup pin until separate evidence resolves ownership; no TTL or process scan invents that evidence.
- **Persistence:** remote install-control metadata owns machine-local binary retention/selection; local SQLite owns known logical connection/resource routes. No provider/domain state is moved remotely. Use existing Effect Schema/SQL patterns, not a new validation library or remote database dependency.
- **Platform:** automatic artifact install is currently Linux shell-based (`flock`, GNU `stat/readlink`, `sha256sum`). Preserve unsupported-target behavior, local stdio watch agents, explicit custom binary paths, and diagnostic direct-SSH configuration. Verify both supported Linux architectures in integration; do not widen platform support here.
- **Recovery bounds:** preserve existing three-attempt process/PTY transport budgets, introduce bounded startup/handshake deadlines using existing 30-second command ceiling, and never let retries alter runtime identity. Test the deadline behavior rather than depend on sleeps.
- **Safe default on incomplete evidence:** retain binaries/routes, suppress new admission to uncertain candidate, reconcile later. Fail before sending work when durable routing/pin persistence fails.

Verify these defaults with tests in phases 1–7. New evidence contradicting the protocol or ownership boundary requires revalidation, not automatic relaxation of guards.

## 5. Scope

### In scope

Install-manager staging/activation/control metadata/cleanup; compatible legacy bootstrap; explicit fresh admission; generation-pinned pool and all resource/control/recovery clients; durable known routing; typed health/fallback; RPC/UI states; fault/integration tests; deliberate integration of inherited partial patches.

### Non-goals

No destructive shared-state takeover, freeze/scan/guardian protocol, supervisor singleton proof against independent legacy stdio, global legacy fencing, all-session inventory, journal import/repair/expiry reconciliation, transparent PTY migration, supervisor-triggered predecessor deletion, release engineering, production SSH, or arbitrary owner termination. Do not update obsolete takeover checklists as though implemented.

### Behavior preserved

Old default state, socket, epoch, journal, binaries, and `bin/current`/`bin/previous` discovery remain untouched by the transition. Independent old callers continue using their original runtime/client. Keep SSH host-key/credential validation, signed artifact policy, immutable content-addressed installs, protocol/capability enforcement, operation digests and sequences, workspace confinement, output bounds, local workspace watching, and direct-SSH diagnostic opt-in. Never choose direct SSH as automatic replay of ambiguous agent work.

## 6. Repository findings and reuse targets

All remote-agent filenames below are relative to `apps/server/src/remote-agent/` unless fully qualified.

| Area                         | Existing owner / reuse                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Artifact provenance/download | `remoteAgentArtifact.ts`, `remoteAgentArtifactDownload.ts`, `remoteAgentInstallSource.ts`, `remoteAgentHttpDownload.*`; retain signature, size, hash, target checks and cancellation policy                                                                                                                             |
| Identity/transport           | `remoteAgentIdentity.ts`, `remoteAgentConnection.ts` (396 lines), `remoteAgentSupervisor.ts`, `remoteAgentDefault.ts`                                                                                                                                                                                                   |
| Lifecycle/composition        | `remoteAgentConnectionPool.ts`, `remoteAgentLifecycle.ts`, `remoteAgentComposition.ts`, `remoteAgentServerLayer.ts`                                                                                                                                                                                                     |
| Stateful consumers           | `remoteAgentProcessClient.ts`, `remoteAgentPtyClient.ts`, `remoteAgentPtyAdapter.ts`, `remoteAgentWorkspaceClient.ts`, `remoteAgentWorkspaceWatchClient.ts`, `agentWorkspaceWatch.ts`, `remoteAgentToolRunner.ts`, `remoteAgentShell.ts`, `remoteAgentGit.ts`, `../workspace-runtime/Layers/WorkspaceRuntime.remote.ts` |
| Server contract/RPC          | `packages/contracts/src/server/server.ts`, `server/ipc.nativeApi.ts`, `server/rpc.core.ts`, `server/rpc.ts`, `constants/websocket.constant.ts`; `apps/server/src/ws/wsExecutionTargetVerification.ts`, `wsRpcHandlers.gitTerminal.ts`, `wsRpcContext.ts`                                                                |
| UI                           | `SidebarRemoteAgentInstallDialog.tsx`, `Sidebar.projectAddActions.remote.ts` (393 lines), `.remote.types.ts`, `SidebarRemoteProjectDialog.tsx`; `useRemoteExecutionAccessGate.ts` (384 lines), `.shared.ts`, `.checks.ts`, `stores/remoteAccess/remoteAccess.store.ts`                                                  |
| Persistence                  | `apps/server/src/persistence/Services/ProviderSessionRuntime.ts` and `Layers/ProviderSessionRuntime.ts` as schema/repository patterns, not a place to overload provider identities; `Migrations.ts`, currently through 110                                                                                              |
| Tests                        | Neighboring `remoteAgentInstall.*.test.ts`, manager/server-layer/pool/lifecycle/process-reconnect/PTY/watch suites and sidebar `.browser.tsx` fixtures                                                                                                                                                                  |

Use focused dot-notation modules. Split transport launch/handshake from the nearly-full `remoteAgentConnection.ts`; split sidebar verification/connection actions and access-gate logic before expanding their near-limit files. Count every materially edited source/test; the lint test-file check does not replace the all-language 400-line rule. No generated route-tree or codec hand edits.

## 7. Implementation steps / phases

### Phase 0 — Protect and classify inherited work

1. Compare HEAD/worktree with section 10; preserve unrelated edits. Do not stage any file. Keep the protected working document untouched.
2. Retain the unsafe-legacy-prepare regression in `remoteAgentSupervisor.test.ts`, but refine it to assert supported raw proxy launch and explicit runtime state rather than destructive rollback. The narrow legacy guard in `remoteAgentSupervisor.ts` stays until no reachable managed update/recovery route can invoke unsupported preparation.
3. Replace the destructive transaction in `remoteAgentInstall.transaction.ts` and `.activation.ts` rather than layering isolation after link switching. Preserve the inherited improvement that reports original failure plus recovery failure; adapt `.transaction.test.ts` to candidate/fallback diagnostics with no baseline preparation.
4. Preserve the inherited read-only journal validation in `crates/bigbud-remote-agent/src/operations/journal.rs`, `journal/inspect.rs`, `inspect.relationships.rs`, `inspect.tests.rs`, and error propagation in `supervisor/prepare.rs`. These are independent conservative hardening, not authorization to inspect/repair/take over legacy state. Run their Rust regressions; add no stale-history bypass. If review proves a defect, refine only that concern and its test.

Exit: explicit inventory of retained/refined/superseded changes; unsafe old activation path cannot remain the default after later wiring.

### Phase 1 — Runtime identity, compatibility, and durable schemas

Add `remoteAgentRuntime.ts`, `remoteAgentCompatibility.ts`, and small `remoteAgentRuntime.*.test.ts` / compatibility tests.

Define a validated immutable descriptor containing generation ID, build identity (version, SHA-256, build digest, target triple), canonical binary/state/socket/log paths, origin (`managed` or `legacy-external`), supported launch mode, and protocol compatibility policy. Keep expected epoch/instance identity in the runtime binding; never confuse build digest with artifact SHA. Resolve remote HOME/canonical root once under verified SSH identity; store actual paths, not arbitrary shell fragments. Short opaque generation IDs keep Unix socket paths bounded.

Compatibility procedure:

1. Authenticate staged artifacts using existing trust store/signature/size/hash/target checks. Check the immutable binary directly with stateless `--check` and compare exact expected metadata before marking staged.
2. Live connection validates protocol major, required capability majors, identity, OS/architecture, nonempty epoch/instance, and sane positive negotiated limits. Gate individual optional capabilities at their owning operation.
3. Permit check 0.2.205/live 0.1.0 only for the recognized legacy build whose check/build digest/OS/architecture and observed endpoint identity agree; retain exact comparisons otherwise. Use signed legacy artifact metadata/hash when establishing a newly trusted legacy fallback. Source commit strings and self-reported hello are not artifact authentication.
4. A pre-existing owned compatible legacy connection may continue on its observed binding without claiming authenticated fallback provenance. If a legacy binary cannot be authenticated for a new fallback, retain it and old work, show fallback unavailable, and do not broaden trust or stop the connection.
5. Legacy recovery uses raw supported `--proxy` at the pinned old root. An absent original supervisor is continuity unavailable, not permission to relaunch it or recreate PTYs. For candidate-only preparation, never call takeover against an unexpected process even inside its intended root: fail/quarantine the identity mismatch.

Add remote metadata schema and pure state transitions in `remoteAgentInstall.registry.ts` and `.registry.transitions.ts`:

- Schema version and monotonic revision; target/remote-root identity; build records with artifact provenance and health (`staged`, `healthy`, `quarantined`), promotion sequence, last classified failure, binary-presence state.
- Runtime records with immutable descriptor, expected epoch once verified, ownership marker, and lifecycle state; current healthy selector, pending build/runtime, fallback derived from healthy promotion order.
- Activation intent with attempt ID, request idempotency key, selected runtime, prior selector, phase, revision/fencing token, and verification result. Health is distinct from transient `unreachable` availability.
- Durable remote pins keyed by owner/connection/resource or activation intent, including `unknown-legacy-owner`; no timeout-based release of unresolved work. Cleanup intent/tombstone records support retry after interruption.

Add `persistence/Migrations/111_RemoteAgentRuntimeBindings.ts` (renumber only if migration inventory changed), register in `Migrations.ts`, and add `Services/RemoteAgentRuntimeBindings.ts` plus `Layers/RemoteAgentRuntimeBindings.ts` and tests. Persist logical connection ID, target fingerprint, descriptor, expected epoch, admission intent, stable owner/resource IDs, operation digest, last durable output/input acknowledgement, and lifecycle (`prepared`, `may-have-been-sent`, `accepted`, `terminal`, `outcome-unknown`). No command bodies, credentials, or output blobs in routing rows. Use unique identities and SQL transactions; do not overload provider session tables.

Exit: schemas reject unsafe/corrupt descriptors; compatibility fixture tests prove narrow legacy exception and rejection of lookalikes; migrations round-trip known routes.

### Phase 2 — Remote control store and staging without startup

Add `remoteAgentInstall.registry.shell.ts` and `.registry.store.ts` with injected `runRemoteCommand`; split path validation/cleanup helpers as necessary. Use new private `$HOME/.bigbud/agent/control-v1`, separate from every runtime. Runtime roots live in `$HOME/.bigbud/agent/runtimes/<generation>`; binaries keep existing immutable paths. Leave old state and old discovery links untouched, including during bootstrap.

Use the existing install script's private-directory/owner/no-symlink validation, strict status parsing and remote `flock` pattern, but a new control lock. Store a bounded validated JSON registry prepared/decoded by TypeScript; shell transports bytes without requiring remote Node/Python/jq or evaluating JSON. A write acquires the remote lock, verifies expected revision, writes a private temp record, flushes it and its containing filesystem metadata using supported Linux durability primitives, then atomically renames. Read under the lock; reject invalid/truncated/newer-schema metadata. Verify required durability primitives in platform fixtures and fail before mutation if unsupported. Do not hold locks in background supervisors/proxies.

All registry mutation, pin acquisition/release, selector publication, and cleanup selection share this lock/revision discipline. In-process install tails remain an optimization, not cross-process serialization. Conflicting revisions reread and recompute; never publish an old snapshot over new pins. Bound registry reads and records; at capacity fail admission/staging safely rather than evict unresolved pins.

Refactor `remoteAgentInstall.ts` and `remoteAgentInstallManager.ts`:

1. Resolve/verify/download, install immutable bytes, statelessly check exact installed path, then record pending descriptor atomically. Do not create/open old state and do not call activation/preparation/proxy/hello during staging.
2. An identical staged artifact is idempotent; concurrent different stages serialize publication, preserving any activation reservation. A later stage must not rewrite an in-progress connection's candidate. Unselected staged artifacts remain nonhealthy and can be cleaned only without pins.
3. If cancelled before publication, current/pending remain unchanged. If publication acknowledgement is lost, reconcile by artifact/intent identity; do not erase a committed pending record. Never report ready merely because bytes were installed.
4. Bootstrap missing control metadata by read-only discovery of old binary/default state and existing owned pool binding. Register external legacy descriptor and conservative unknown-owner pin. Do not inventory journals, rename directories, change old links, or run old prepare. Existing stale `activation.pending` belongs to historical control and is not automatically “recovered” by this manager.

Update `remoteAgentServerLayer.ts` installer to return staged/pending status and remove `pool.close(target)`. Staging cannot invoke connection resolution indirectly through health reporting.

Exit: real shell tests show candidate `--check` only, zero candidate processes/state files, immutable old links/epoch/journal, idempotent pending publication after lost replies.

### Phase 3 — Explicit fresh admission and isolated activation

Add `remoteAgentAdmission.ts` and `.activation.ts`; repurpose `remoteAgentInstall.transaction.ts` for isolated activation orchestration. Replace `.activation.ts` old shell transaction builders with control-store operations; do not retain an exposed destructive rollback alias used by managed updates.

Introduce an explicit `server.connectRemoteAgent` RPC with target, fresh connection request ID, and intent `fresh`; return connection ID and current/pending/fallback summary. Wire exact contract siblings listed in section 6, native API transport, `wsRpcHandlers.gitTerminal.ts`, and server context. Existing verify RPC remains observational/recovery-only. Omitted intent in old client requests never implies fresh. Retry the same fresh request ID returns/reconciles the same binding, not a new generation.

Activation flow, with server-side work admission closed:

1. Under registry lock/revision, select pending nonquarantined build, else most recent compatible healthy build; reserve exact runtime and activation pin. Write intent before starting any process. No candidate/fallback available means fail clearly before work.
2. Create/validate only the reserved private state root, consistently set `BIGBUD_AGENT_STATE_DIR` on preparation (where supported), supervisor, proxy and checks that need state. Use immutable binary path, never current/previous links.
3. Start at most one owned supervisor for this exact runtime. Serialize launch under a short runtime launch lock; release lock descriptors before detaching. Repeated/concurrent requests first reconcile the exact existing socket/hello. Do not stop a mismatched listener, truncate useful logs, or create a replacement root.
4. Connect raw proxy to that runtime, bound handshake deadline, validate identity/capabilities/epoch and a bounded supported diagnostic response (`agent-ready`). Diagnostic work is internal, uses a distinct ID, and sends no user process/PTY/file mutation. The full hello/readiness probe—not `--check` alone—proves health.
5. CAS-publish healthy promotion and selector, clear only the matching pending record, and record the exact expected epoch. Persist local connection binding and remote connection pin before returning the connection for user use. A failure in local persistence leaves a conservative remote pin and no admission; reconcile by intent ID on retry.
6. Close probe-only transports without killing supervisors. Preserve old runtime and pool entries. Reconcile lost finalize/return responses by durable intent, actual identity, and the same request ID; do not revert a proven active runtime or erase state.

For startup/readiness errors demonstrably local to candidate (bad binary/check, unsupported protocol, identity mismatch, definitive supervisor startup exit, verified readiness failure), quarantine new admission and attempt the most recent compatible proven healthy fallback immediately within bounded startup time. If no fallback passes readiness, fail before work. Fallback choice does not promote the failed candidate or reorder healthy history.

For SSH/auth/network timeout/lost acknowledgement, record availability/activation uncertainty, not unhealthy binary. Since no user work is admitted, a separate verified fallback connection may be selected if reachable, retaining the uncertain candidate intent/pin; if reachability prevents verification, fail unavailable. Never delete/stop an uncertain candidate as recovery. Reconcile later without consuming unrelated pending work.

Exit: no work can bypass admission even when browser verification times out; simultaneous fresh requests cannot create duplicate runtimes or publish stale selectors.

### Phase 4 — Full generation pinning and restart recovery

Refactor `remoteAgentConnectionPool.ts` to key by target identity + runtime generation, not target alone. Factory creation takes an immutable descriptor and fixed expected identity/epoch. Separate resolving fresh admission, acquiring an existing logical binding, and reconnecting a descriptor. No reconnect callback may invoke the mutable target selector.

1. Update `remoteAgentComposition.ts`, `remoteAgentDefault.ts`, `remoteAgentConnection.ts` and `remoteAgentSupervisor.ts` to inject runtime resolution/persistence and launch modes. Keep local/ephemeral agent callers unchanged. Move SSH launch/identity helpers into `remoteAgentConnection.launch.ts` to keep the class below 400 lines. Fix lifecycle epoch mismatch so the original expected epoch never changes on failed recovery, even after repeated calls/server restart.
2. Pool leases/pins cover logical connection, in-flight creation, process, PTY, workspace and watch owners. Capture one descriptor before workspace open and retain it through dependent creation. Change PTY resolver to return a pinned client bundle instead of separate target resolutions. Make watch resubscription close over original runtime; signal rescan as today. Per-request read clients release transient leases after completion; watches/PTYs release only on actual disposal/confirmed terminal outcome.
3. Pass explicit bindings through process/shell/Git/tool and workspace resolver interfaces listed in section 6. Existing target-only call sites resolve the persisted current admission binding once; do not activate pending inside generic `get` or `resolve`. Existing resource control always resolves by resource binding. Queued work already belonging to a logical connection retains that binding; selection changes apply only to the explicit fresh logical connection and its newly admitted resources.
4. Before any potentially mutating frame, persist local resource route/intent and remote pin, then mark `may-have-been-sent` durably before dispatch. Preserve accepted/unknown references across transport close and process restart. A failed write callback is not proof no bytes reached the peer. Track PTY creation IDs before sends; input sequence/ack recovery must never reset and replay old input under new IDs.
5. Remove the `unknown or expired` automatic process resubmission branch. Attach/cancel/output acknowledgement/retry use original runtime and epoch; absence/expiry yields typed `PROCESS_OUTCOME_UNKNOWN`, not a new execution. Retry only when non-dispatch or definitive rejection is established, on the original binding. Keep read-only retry behavior bounded. Replace `canFallback(boolean)` with explicit admission/dispatch classification so unknown is never treated as false acceptance.
6. PTY close/cancel failure cannot release the pin merely because the local `finally` reports exit (`remoteAgentPtyClient.ts:127-140`). Preserve unresolved remote dependency until terminal confirmation/reconciliation. Transport shutdown releases transports, not operation ownership.
7. Startup loads local binding rows before any generic resolver or cleanup. Restore expected epochs and known IDs; known process recovery attaches only, known PTYs attach only where supported. Missing original endpoint/changed epoch is a visible unresolved route, not fresh creation. Preserve independent old stdio access via its original owner; never claim server restart can resurrect an unowned stdio transport.
8. Order release: persist terminal/resolved local outcome first, then release remote pin idempotently, then evict unused pool connection. Crash between steps retains extra files rather than losing recovery. Old session data created before this migration cannot be fabricated; bootstrap conservative legacy pin and retain original known in-memory owners until they finish.

Exit: old client remains usable through candidate staging/activation/quarantine; all accepted/unknown fault tests have one marker execution and fixed original route after repeated restarts.

### Phase 5 — Health, two-healthy retention, and install-manager cleanup

Add `remoteAgentInstall.health.ts`, `.retention.ts`, `.cleanup.ts` and focused tests. The install manager is the sole cleanup owner; do not add predecessor-deletion behavior to Rust agent startup.

1. Pure retention reducer keeps top two healthy build identities by first promotion sequence plus all runtime/owner/activation/recovery pins. A quarantined former healthy build is excluded from new selection but retained while referenced; lower healthy builds become eligible fallback. Reverification never makes a staged/unhealthy build silently healthy: only the same explicit activation/verification flow can restore eligibility.
2. Quarantine is a durable selection exclusion, not deletion. Classify artifact integrity/protocol mismatch as build failure, local runtime-state corruption as runtime quarantine without declaring all copies of the build defective, and network/SSH/auth failures as availability. Application command nonzero exit, ordinary workspace permission errors, and resource saturation do not establish broken binary.
3. Every live managed supervisor is itself a binary reference. Do not kill supervisors as part of this update. If an old healthy supervisor remains alive, keep its binary beyond the two slots. Cleanup can proceed after verified normal runtime exit and resolution of all resource/recovery pins. Unknown/legacy runtime liveness blocks cleanup; a failed connect is not proof of death.
4. Under the same remote lock, re-evaluate pins/current/pending/health, validate owned canonical immutable build path and expected hash, record a deletion tombstone excluding new acquisition, and unlink only the exact unreferenced binary (then empty managed binary directories). Keep tombstone metadata until retry/reconciliation confirms deletion. Never recurse through arbitrary paths or delete a referenced version directory containing another build.
5. Keep runtime roots/journals and useful per-generation/attempt logs outside binary directories; do not remove them during binary retention. Existing runtime data cleanup remains separate and cannot weaken unresolved pins. At storage exhaustion return a concise safe failure; do not evict active/fallback/recovery files to make space.
6. Run bounded cleanup after successful promotion, confirmed release, and startup reconciliation, not on every request. Defer uncertain work and expose reason/count without unbounded retry loops. Cooperative acquisition and cleanup races must be mutually exclusive under revision/lock; target aliases sharing canonical install root share remote state.

Exit: H1/H2 + staged H3 keeps H1/H2; healthy H3 makes H1 eligible only when unpinned/dead; pinned H1 or quarantined active H2 survives; cleanup fault retries cannot delete H3/H2 or logs.

### Phase 6 — RPC health and user-visible current/pending/fallback

Refactor `remoteAgentServerLayer.ts` health to evaluate the actual bound runtime rather than demanding the newest artifact. Update `packages/contracts/src/server/server.ts` using existing Effect schemas: keep `ready` for compatible serving access and add optional structured current runtime/connection, pending staged version, fallback version, availability and concise error code/detail. Keep install-required/incompatible handling; “upgrade-required” must mean truly incompatible access, not ordinary newer artifact availability. Install result explicitly says staged, never active/ready.

1. `wsExecutionTargetVerification.ts` maps the richer summary; no verify call consumes pending or rebinds a resource. Add dedicated fresh admission effect/handler from phase 3. Error wrappers preserve diagnostic causes server-side but expose bounded phase/code/message; do not interpolate giant `runSshCommand` errors/scripts into RPC messages.
2. In sidebar add/edit and install dialog, label the action “Download update”; success reads “Update staged. It will be used on your next new connection.” Existing compatible projects remain usable. Do not call fresh admission from `completeRemoteAgentInstall`, auth success, generic verification, or toast Retry.
3. Add one named `SidebarRemoteAgentStatus.tsx` component showing current connection version, pending version, and fallback version/none, including retained old connection notice. Add explicit “Connect new session” control that invokes fresh RPC with a stable request ID across retry. For a first install, staging completion offers this control rather than implicitly executing work. A deliberate new-project connect uses the same explicit admission boundary before workspace work; verification alone is observational.
4. Split sidebar remote connection actions into `Sidebar.projectAddActions.remote.connection.ts` and access checking into focused hook helpers. Persist/display returned logical connection ID in remote-access state; clear only the fresh-action verification cache when needed, never erase old resource routes. Browser WebSocket reconnect/reload restores state, not a fresh action.
5. Display fallback as warning with exact active version; failed candidate and failed fallback produce a concise combined message. Blue working, green staged/ready success, amber fallback/unavailable warning, red terminal failure. Use `text-sm` defaults, `text-xs` secondary text, accessible button names, no icon-only severity.

Exit: browser tests demonstrate staged update visible while old work remains interactive; clicking fresh connects candidate/fallback; automatic reconnect never triggers fresh RPC.

### Phase 7 — Integration acceptance matrix and completion evidence

Add split fixtures/tests under `apps/server/src/remote-agent/remoteAgentUpgrade.*.test.ts` and `remoteAgentUpgrade.fixtures.ts`; put real-process Linux harnesses under `crates/bigbud-remote-agent/tests/` or focused server fixture helpers, each <=400 lines. Test the TypeScript install/admission/pool paths with injected local shell execution rather than SSH. Use private HOME/state roots and owned child handles; no host production state or network needed for execution tests.

| Case                                                                                                      | Required observable evidence                                                                                                                                |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actual 0.2.205 fresh/stale/retention-expired history, stage candidate                                     | Zero candidate supervisor/proxy, unchanged old epoch/journal/socket/discovery, old command/PTY remains usable                                               |
| Independent legacy stdio/default proxy before/during/after staging and activation                         | Same old paths/owner access; new isolated root never imports or alters old journal                                                                          |
| Deliberate new connection                                                                                 | Candidate exact identity, protocol/capabilities and diagnostic verified before first workspace/user frame; pending clears only after commit                 |
| Transport loss after staging or activation                                                                | Old process attach/cancel/ack and PTY input/resize/close stay original generation; no selector calls from recovery                                          |
| Lost acceptance / accepted-before-spawn / expired attach                                                  | Persisted original route; one side-effect marker; typed unknown on missing continuity, zero fallback sends for that work                                    |
| Workspace/PTY/watch creation racing fresh activation                                                      | Each creation and dependent handle use one runtime; watch reconnect requires rescan without migration                                                       |
| Candidate exit/bad hello/readiness timeout with verified local failure                                    | Quarantine first, healthy fallback before user work, no old preparation; fallback failure concise and bounded                                               |
| Candidate later unhealthy with accepted work                                                              | New fresh connection can select fallback; original operation recovery remains candidate-bound                                                               |
| Three healthy builds plus active/recovery pins                                                            | Keep newest two and pinned older builds; staged/unhealthy never evicts healthy; third deleted only after proven release/exit                                |
| Network/SSH/auth failures, ambiguous launch/publication                                                   | No binary-unhealthy conclusion, no deletion, no silent accepted-work replay; reachable fallback allowed only for not-yet-admitted connection                |
| Server restart at every routing/pin/dispatch boundary                                                     | Original descriptor/epoch/IDs restored before recovery; terminal release is idempotent; unresolved legacy stays retained                                    |
| Concurrent installers/activators/cleanup across processes and target aliases                              | CAS conflict retry, one runtime launch, no stale publication, no binary deletion after pin acquisition                                                      |
| Interrupt before/after staged publish, launch, readiness, healthy commit, binding write, tombstone/unlink | Retry same intent/generation; no duplicate healthy slot, no destructive rollback, safe orphan pins, useful logs retained                                    |
| Compatibility negative cases                                                                              | Wrong build/hash/OS/architecture/protocol/required capability rejected; 0.2.205/0.1.0 exception cannot authorize lookalikes; optional cleanup remains gated |
| Corrupt metadata/symlink/unsafe owner/path escape/disk full                                               | Fail closed before start/delete; no user-controlled shell interpolation; previous healthy/legacy data unchanged                                             |
| UI/install cancellation/background verification/reload                                                    | Accurate current/pending/fallback, no fresh activation from automatic paths, concise errors, no early work dispatch                                         |

Build exact legacy source from the named SHA into disposable external/container output with build version 0.2.205 and explicit fixture digest; build candidate separately. Record architecture and source/build provenance. Source-built debug/release fixtures are not signed artifact certification: test actual installer signature/hash verification separately with signed test fixtures and rejection of tampering. Use the protected investigation's `/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode` harnesses as evidence/reuse references only after inspecting them; do not stage temp artifacts.

## 8. Validation plan

Implementation agent runs, from repository root:

```sh
bun run --cwd apps/server vitest run src/remote-agent
bun run test --filter=@bigbud/server
bun run test --filter=@bigbud/contracts
bun run --cwd apps/web test:browser
bun fmt
bun lint
bun typecheck
bun run test
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
git diff --check
```

Browser prerequisites, if not already installed: `bun run --cwd apps/web test:browser:install`. Never run `bun test`. Run Rust gates because inherited Rust edits are part of the intended integrated work even if isolation needs no new Rust behavior. Run Linux-only shell/real-binary suites on Linux aarch64 and x86_64; macOS skips are not passes. Keep server suites sequential. No production SSH is needed or permitted; replace command execution with owned local/container fixtures.

Record exact commands/results, platform skips, fault points, marker counts, byte/identity preservation, and initial/final worktree state. Add regression tests that demonstrably fail against the current target-only reconnect and eager activation behavior. Manually review protocol capability comparisons, lock/pin ordering, all cleanup path validation, and every catch/finally that releases ownership.

Planner validation was read-only source/diff inspection, not these implementation checks. `bun fmt` is mutating and was deliberately not run during planning. Independent implementation review must cover no cross-generation dispatch and no cleanup without proof, not only green test counts.

## 9. Risks and rollout

- **Routing breadth:** a target-only fallback in one PTY/watch/cancel helper can defeat isolation. Audit all listed consumers; tests should spy on runtime descriptor, not merely target ID.
- **Durability dual writes:** local SQL and remote metadata are not one transaction. Intent IDs and conservative remote-first pins/local-first terminal release make interruption leak safely instead of replay/delete. No “missing row means done” reconciliation.
- **Healthy does not mean idle:** verified healthy promotion never authorizes cleanup. Live supervisors and unresolved work are additional pins; retained count can exceed two by design.
- **Unknown old ownership:** automatic legacy retirement may remain blocked indefinitely. Display retained legacy state truthfully; do not add a guardian, inventory fiction, or automatic kill to force a two-file limit.
- **Identity:** validated SSH endpoint and self-reported hello are necessary but not signed artifact provenance. Keep artifact authentication distinct from continuity of an already-owned connection.
- **Boundedness/security:** cap registry reads and admissions, validate canonical paths/ownership, keep private logs separate, avoid leaking scripts/credentials in UI. Disk pressure must fail safely.
- **Rollout:** wire all generation-aware paths before enabling pending activation. No new agent wire protocol or released legacy modification is needed for the core coexistence mechanism. Start with deterministic local fixtures, then actual legacy Linux matrix. This plan authorizes no rollout to VPS or publication.
- **Rollback:** disable new fresh candidate selection/quarantine the failing candidate and select healthy fallback only for fresh unadmitted work. Keep all old and accepted candidate routes/data. Reverting application code to target-only discovery is NOT a safe runtime rollback; old app cannot recover newly isolated routes. Preserve new metadata and report this downgrade limitation, never rewrite old discovery links to hide it.

## 10. Plan validity / current state

Initial, post-discovery, and post-plan-save `git status --short` matched. Index was empty (`git diff --cached --stat` empty). The newly saved plan is also ignored by existing repository rules; its absence from status is expected, and no ignore rules or Git state were changed. Initial tracked modifications:

```text
apps/server/src/remote-agent/remoteAgentInstall.transaction.ts
apps/server/src/remote-agent/remoteAgentSupervisor.ts
crates/bigbud-remote-agent/src/operations/journal.rs
crates/bigbud-remote-agent/src/operations/journal/inspect.rs
crates/bigbud-remote-agent/src/operations/journal/inspect.tests.rs
crates/bigbud-remote-agent/src/supervisor/prepare.rs
```

Initial untracked files:

```text
apps/server/src/remote-agent/remoteAgentInstall.transaction.test.ts
apps/server/src/remote-agent/remoteAgentSupervisor.test.ts
crates/bigbud-remote-agent/src/operations/journal/inspect.relationships.rs
```

Tracked diff: six files, 242 insertions / 35 deletions; all nine partial source/test files were inspected. This plan is the only authorized new planning file. The protected investigation is ignored (`git check-ignore` confirmed); do not assume ignored means disposable.

Instructions inspected: supplied global assistant instructions, root `AGENTS.md`, `crates/AGENTS.md`, `docs/plan/_plan-authoring-guide--do-not-delete.md`, and surfaced `docs/CONTEXT.md`; accepted native boundary read. No other repository `AGENTS.md` found. Required plan content is organized under this planner's mandated metadata/goal/evidence/scope/phases/validation/handoff sections, incorporating the repository guide's summary, related work, non-goals, risks, criteria, and questions.

Toolchain constraints from `package.json`: Bun 1.3.9, Node ^24.13.1, Vitest ^4, Effect 4.0.0-beta.43, Oxfmt/Oxlint; reuse current lockfiles, no dependency additions planned. External fixture evidence is historical and must be reproduced for acceptance.

Revalidate if HEAD/worktree changes, migration 111 is occupied, artifact signing/protocol/source identities differ, transport configuration/custom binary handling changes, new stateful consumers appear, or cleanup/admission ownership semantics differ from this baseline. Stop on unexpected worktree edits; never discard them.

## 11. Handoff notes / open questions

### Recommended order

Completed independent plan challenge → classify inherited patches → schemas/compatibility/persistence → safe staging → explicit admission/isolated startup → complete pinning/recovery → cleanup → UI → full Linux/application matrix and checks. Tests accompany each phase; do not ship a half-wired selector switch before pinning exists.

### Settled decisions not to reopen without new evidence

Coexistence, staging without supervisor startup, activation only on explicit fresh connection, original-owner access rather than transparent import, narrow validated legacy compatibility, no accepted/unknown replay, two healthy builds plus dependency pins, quarantine before deletion, install-manager cleanup, concise truthful UI, protected working document, no production/Git/release actions. These are approved product behavior, not outstanding permission questions.

### Review record and readiness gate

- Requirements review pass: every agreed requirement maps to section 2 and phases 1–7; obsolete takeover scope is explicitly excluded.
- Execution-readiness review pass: corrected additional hazards found in source—epoch overwrite after mismatch, PTY workspace/client split resolution, unknown/expired same-generation resubmission, local PTY-finally release, UI optimistic verification, and live-supervisor binary pins. Specified dual-store interruption ordering and fresh-request idempotency.
- **Independent review completed:** parent `ses_f872b2eb6ffexznIco6PpHfj4X` supplied the mandatory corrections below. This supersedes the historical unavailable-review statement. Parent performs final independent implementation review; absent delegation tools are not a blocker.
- **Remaining approval blocker:** None.

### Mandatory independent-review corrections (2026-09-07)

These refine and override conflicting implementation details above:

1. **Application owner recovery:** persist and restore `(threadId, terminalId)` → logical connection/generation/PTY identity through terminal `Manager.session.ts`, `Manager.process-drain.ts`, adapter types and startup. Higher-level retryable runners require stable invocation identity. Resolve durable owners before spawning; existing unresolved owners attach or report unknown, never allocate a new ID. Only truly unbound new owners use the default. Test actual manager/runner APIs after full server restart and newer activation.
2. **Launch reservation:** write a durable reservation before spawn, and hold the launch lock across the parent/child handoff until the child has established ownership. An absent socket is not nonlaunch/death evidence: join/reconcile uncertain reservations and suppress replacement. Never invoke takeover preparation against uncertain endpoints. Kill the controller postspawn/prebind, start a second controller, and prove one writer/epoch. The short lock/release-before-detach prescription in phase 3 is superseded by this interruption-safe handoff.
3. **Publication durability:** reserve the build under the registry lock BEFORE install/reuse/check, including restaging a cleanup-eligible old build. Flush temporary file, rename, flush containing directory/filesystem, then acknowledge. Apply equivalent tombstone/unlink ordering. Release/convert reservation only after reconciled publish/cancel. Test cleanup race and lost acknowledgement after rename.
4. **Terminal evidence:** share a classifier for cancellation requested, verified terminal, missing history and rejected control. Actual legacy `terminal=true, detail=operation-unknown-or-expired` is NOT completion. Retain outcome-unknown/recovery pins. Audit process cancel, shell closeThread swallowed failures, and PTY-finally release; actual legacy missing/expired cancellation must cause zero redispatch.
5. **Output/input durability:** cursors alone are not durable output. Reuse durable output/history ownership or explicitly surface an output gap after crash; never return a silently truncated successful result. Persist next allocated input sequence independently from acknowledged input. Missing pending bytes cannot cause sequence reuse or invented replay. Cover crash before/after output acknowledgement and input send, including legacy attach without input watermark.
6. **Privacy:** use fixed-size hashes for NEW request and durable routing digests, reusing `remoteAgentProcessRequestDigest` or a shared helper. Never persist raw command/file-content JSON as a digest, and never rewrite identities of already accepted wire requests. Test routing rows contain no secret-bearing command/content.
7. **Evidence:** run actual legacy Linux stage-no-start, continuity, explicit isolated activation, application-level restart, fallback/network classification, retention two plus pins, cleanup concurrency/unknown owners, interrupted launch and publication reconciliation tests. Saved source fixtures are not authenticated published artifacts. Record actual aarch64/x64 execution and gaps precisely.

### Implementation tracking

- [ ] Runtime/compatibility schemas and durable application-owner routing.
- [ ] Locked staging reservations and crash-durable registry publication.
- [ ] Explicit admission and interruption-safe isolated launch.
- [ ] All consumer pinning, terminal evidence, durable output/input and privacy.
- [ ] Two-healthy retention, quarantine, conservative install-manager cleanup.
- [ ] RPC/UI current, pending, fallback and explicit fresh action.
- [ ] Actual legacy Linux/application fault matrix and required checks.
- [ ] Parent final independent implementation review.

No implementation was performed by this planner.

## 12. Implementation evidence and remaining integration (2026-09-07)

The preceding planner statement is historical. Implementation has now begun, but
the complete staged-update feature is **not implemented**. Do not deploy or describe
the following foundations as a complete update flow.

Implemented and exercised:

- `remoteAgentProcessClient.ts` no longer redispatches after an unknown/expired
  acceptance. Missing history has typed outcome-unknown semantics. Attach reports
  an output gap when the requested prefix has been acknowledged/expired, including
  when a successful completion arrives without retained output.
- `remoteAgentLifecycle.ts` preserves the original expected epoch through repeated
  failed reconnects. This is not yet durable application-owner recovery.
- Shared `remoteAgentTerminalEvidence.ts` rejects legacy missing-history terminal
  flags as completion. Shell cancellation failures propagate and unresolved
  in-memory shell owners cannot be overwritten/reexecuted. PTY close acknowledgements
  and failures do not fabricate an exit event; `ptyExited` is the completion evidence.
- New shell/workspace request digests are SHA-256 rather than secret-bearing JSON.
  Accepted wire digests are not rewritten. Durable routing rows remain unimplemented.
- Runtime descriptors, registry schema/reducers, CAS store and Linux publication
  scripts are added. Staging reservations block cleanup, published intents reconcile
  idempotently, retention includes two healthy builds plus conservative references,
  and tombstones prevent late acquisition. These primitives are NOT yet wired into
  the install manager or an actual binary-deletion executor.
- Isolated launch primitive durably reserves before spawn, inherits the runtime
  lock through the child lifetime, suppresses replacement on uncertain reservations,
  verifies immutable binary hash, and never calls preparation/takeover. Raw pinned
  proxies use explicit state roots. Ordinary legacy proxy launch uses its supported
  `--proxy` flag instead of unsupported preparation.
- All inherited Rust journal hardening remains intact. No additional Rust takeover,
  guardian, state import, or binary cleanup was added.

Critical remaining integration (not an approval/delegation blocker):

1. `remoteAgentInstallManager.ts` still calls the old activation transaction;
   `remoteAgentServerLayer.ts` still closes the target pool after install. The new
   registry/staging primitives must replace this path before staging is complete.
2. No explicit fresh-admission RPC/UI, pre-admission readiness/fallback coordinator,
   or complete compatible-health gate is wired. The old latest-version health
   requirement remains.
3. No SQLite logical/resource-owner routing or terminal-manager/runner restart
   restoration is wired. The pool remains target-keyed; PTY workspace/client split
   resolution, durable output ownership and input allocation/ack persistence remain.
4. No install-manager cleanup executor or transient-network-versus-quarantine
   coordinator exists yet. Registry retention reducers alone do not satisfy cleanup.
5. The complete actual-application restart/fault matrix and Linux x86_64 runs remain.

Validation evidence:

- `bun fmt`, `bun lint`, `bun typecheck`: passed. Four pre-existing lint warnings and
  pre-existing oversized-test warnings remain outside this patch.
- `bun run test`: passed on retry with sufficient command timeout: 9 Turbo tasks
  successful; server 674 files / 2792 tests passed, 18 tests skipped; web 336 files /
  1990 tests passed. Initial 120-second tool timeout interrupted the full suite;
  the successful rerun took 8m30.75s.
- `BIGBUD_TEST_LINUX_DOCKER=1 BIGBUD_TEST_AGENT_FIXTURES=/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode bun run --cwd apps/server vitest run src/remote-agent`:
  43 files / 255 tests passed, 9 existing Linux-host-gated tests skipped because the
  Vitest host is macOS. The new Docker-backed Linux tests actually executed.
- New Linux tests exercised lost acknowledgement after registry rename, independent
  controller CAS, unsafe symlink rejection, controller kill postspawn/prebind with
  one writer/epoch, and unlocked reservation without socket remaining uncertain.
- Actual source-built Linux aarch64 legacy/candidate fixtures passed isolated startup,
  old operation attach/output, unchanged old epoch, one side-effect marker, candidate
  unknown-history/no-redispatch, and actual legacy missing-history cancellation.
  This is not installer authentication, retained-history expiry, or application-level
  server-restart certification.
- `cargo fmt --all --check`, `cargo clippy --locked --workspace --all-targets -- -D warnings`,
  `cargo test --locked --workspace`: passed on macOS. `docker start -a bigbud-upgrade-reviewed-linux-checks`
  reran workspace Clippy/tests against the read-only mounted worktree on Linux
  aarch64: remote agent 87 passed, one existing privileged bind-mount test ignored.
- `bun run --cwd apps/web test:browser`: NOT green. Existing browser suites emitted
  missing RouterProvider/unknown Ping RPC errors and failed tests in DiffPanel,
  ChatView and TraitsPicker; the run was terminated at the 240-second tool limit.
  No web source was edited. Root cause and any unrelated fixture repair require
  separate diagnosis/scope handling; do not represent this as a passing browser run.
- All edited/authored code files checked are <=400 lines; `git diff --check` passed.

Neither completion gate is green for the complete plan. The browser failures are
a validation problem, not an explanation for the unfinished integration above.
No external blocker to the remaining core implementation has been established.
Nothing was staged, committed, pushed, tagged or released, and no SSH/VPS access
was used. The protected investigation remains unchanged.

## 13. Final implementation evidence (2026-09-07)

This section is authoritative over the historical implementation-progress notes
in section 12. The requested production path is now wired end to end:

- [x] Runtime/compatibility schemas, immutable generation descriptors, durable
      SQLite connection bindings, terminal/process/PTY/workspace owner routes, and
      startup restoration are implemented.
- [x] Install staging verifies authenticated immutable bytes and stateless
      identity without starting a candidate; registry publication uses reservations,
      CAS revisioning, temporary-file/directory flushes, and lost-ack reconciliation.
- [x] Explicit `server.connectRemoteAgent` fresh admission selects one runtime,
      reserves one launch, verifies hello/capabilities/readiness, quarantines only
      definitive candidate failures, and falls back only before user work is
      admitted. Retries preserve the request identity and generation.
- [x] Pools and all stateful consumers retain generation-pinned descriptors;
      terminal owner recovery, output-gap classification, input allocation/ack
      durability, and privacy-safe request digests are wired and covered by tests.
- [x] Retention keeps two proven healthy builds plus live/recovery pins;
      install-manager cleanup uses conservative tombstones, ownership/hash/path
      checks, and deferred keyed maintenance without removing runtime logs.
- [x] RPC contracts and sidebar UI distinguish current, pending, fallback, and
      explicit fresh connection state. Focused browser coverage passes.

Validation after final integration:

- `bun fmt:check`, `bun lint`, and `bun typecheck`: passed. Lint reports six
  non-fatal existing/style warnings and the repository's existing oversized-test
  warnings; no lint errors or policy violations.
- `bun run --cwd apps/server vitest run src/remote-agent`: passed, 43 files / 251
  tests plus 6 skipped on the first local run; Docker-enabled Linux rerun passed
  48 files / 263 tests with 9 platform-gated skips.
- Focused browser UI tests for staged install, explicit fresh admission, and
  project creation: passed, 2 files / 10 tests.
- `bun run test`: passed, 9 Turbo tasks; server 677 files / 2795 tests passed
  with 23 skipped, web 336 files / 1990 tests passed, and all package tasks
  successful.
- `cargo fmt --all --check`, `cargo clippy --locked --workspace --all-targets
-- -D warnings`, and `cargo test --locked --workspace`: passed.
- Actual Docker-backed Linux fixture tests passed for staging-without-start,
  legacy continuity, isolated fresh activation, fallback/network classification,
  application restart recovery, launch reservation, publication durability,
  retention, cleanup races, and owner/input/output evidence. x86_64 Linux was
  not available in this macOS environment.
- The full `bun run --cwd apps/web test:browser` suite remains red on pre-existing
  unrelated RouterProvider/RPC harness failures (19 files / 76 tests failed and
  55 disconnected-server errors). The new remote-agent browser files pass in
  isolation; no unrelated browser harness repair was made.
- `git diff --check`: passed. No files were staged, committed, pushed, tagged,
  or released; no SSH/VPS access was used.
