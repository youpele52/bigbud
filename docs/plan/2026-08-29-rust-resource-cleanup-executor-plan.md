# Rust Resource Cleanup Executor Plan

## Metadata

- **Status:** Ready for implementation
- **Created:** 2026-08-29 15:18:06 CEST (+0200)
- **Last modified:** 2026-08-29 15:37:07 CEST (+0200)
- **Project root:** `/Users/youpele/DevWorld/bigbud`
- **Inspected branch:** `main` tracking `origin/main`
- **Inspected commit:** `e39d7b291e727f18b3400f24274417200132af20`
- **Initial worktree:** clean (`git status --short` returned no entries)
- **Related issue IDs or links:** none supplied

## Goal And Definition Of Done

Replace the TypeScript pathname-based executor for normal thread and project deletion of plain managed files and directories with a narrowly authorized Rust executor. TypeScript remains the only owner of deletion eligibility, resource ownership, immutable cleanup plans, SQLite state, retries, and final outcomes.

The work is complete when:

1. Normal thread deletion sends attachments, provider logs, and terminal history to Rust; normal project deletion sends project memory, notes, and kanban resources to Rust.
2. Managed worktrees, checkpoints, provider/browser/terminal/shell teardown, canonical history, cutoff selection, and every SQLite operation remain TypeScript-owned.
3. TypeScript durably prepares the exact cleanup plan before canonical deletion finalization. Rust cannot execute it until TypeScript proves the expected finalize command payload and deletion event committed.
4. Rust uses descriptor-relative operations on macOS/Linux and verified handle-based operations on Windows, never deliberately follows a symlink, junction, or reparse point, refuses detected mount-boundary traversal, and reports a typed result for every requested resource.
5. A Rust process crash, server crash, timeout, duplicate request, or lost response cannot lose the cleanup obligation. Stable quarantine identity checks prevent known replacement objects from being removed; the design does not claim protection against a malicious same-user process continuously racing final directory-entry mutations.
6. There is no TypeScript fallback for supported plain resources. A missing or incompatible Rust binary fails new deletion closed before canonical finalization; failures after finalization remain durably retryable.
7. Existing deletion behavior remains unchanged for active/pinned checks, fences, subtree selection, shared attachment retention, runtime teardown, canonical SQLite deletion, worktrees, and legacy purge recovery.
8. All repository-required Bun and Rust checks pass, together with focused protocol, persistence, race, recovery, integration, and package-boundary tests across the supported cleanup matrix: macOS arm64/x64, Linux x64, and Windows x64.

## Background And Evidence

### Confirmed Current Behavior

- `docs/RUST_SYSTEMS_CORE.md:43-56` and `:110-129` assign product semantics and canonical SQLite state to TypeScript and systems execution to Rust.
- `ThreadDeletion.files.ts:53-140` discovers resources and captures identity before canonical finalization. `ProviderCommandReactorHandlers.delete.ts:220-275` finalizes SQLite-backed canonical state before calling filesystem cleanup.
- `ProjectDeletion.files.ts:48-92` follows the same discover, finalize, cleanup order for project memory, notes, and kanban resources.
- `EntityPurge.resources.ts:254-344` currently validates root, parent, target, quarantine, and identity around an atomic rename. `EntityPurge.resources.remove.ts:6-59` then recursively deletes by pathname.
- The pathname executor has unavoidable `lstat` to `unlink`/`rmdir` race windows. Its safety checks are valuable, but repeated pathname checks cannot make the final mutation descriptor-relative.
- Direct deletion currently reduces post-finalization failures to warning logs and orphan-resource arrays (`ProviderCommandReactorHandlers.delete.ts:261-275`, `ProviderCommandReactorHandlers.project-delete.ts:138-151`). It has no durable normal-path retry obligation.
- Deletion-request reactors consume a hot non-replayed event stream. A restart can therefore leave canonical `deletingAt` intent without ever reaching resource discovery; cleanup-ledger recovery alone would be incomplete.
- Thread canonical cleanup deletes proven command receipts and canonical events immediately after finalize. Durable cleanup recovery therefore needs its own verified finalize-proof snapshot before that pruning runs.
- Legacy `EntityPurge` jobs are retained for manual recovery and separately own checkpoint/resource claims. They are not the normal deletion pipeline and must not be expanded or reused for this change.
- `bigbud-remote-agent` is already built and packaged for standalone server and Electron distributions (`apps/server/scripts/workspaceAgent.ts`, `scripts/lib/packaged-workspace-agent.ts`). The server already supervises local ephemeral framed-stdio instances through `RemoteAgentConnection`.
- The Rust workspace already uses `libc` for Unix descriptor-relative file writes. `windows-sys 0.61.2` is already present transitively in `Cargo.lock`; the user explicitly approved making it a narrowly featured, target-specific direct dependency for this executor.

### Root-Cause Boundary

This plan does not repair retention cutoff selection. The cutoff, candidate selection, settling, and final eligibility checks occur before filesystem cleanup. This plan addresses filesystem mutation correctness and durable cleanup completion only.

Confidence is high on the ownership and recovery gaps because they are directly visible in the current call paths. Confidence on platform-native implementation details is bounded until real macOS, Linux, and Windows fault-injection tests pass.

## Plan Assumptions

1. **The existing `bigbud-remote-agent` artifact is the local executor binary.** It already has standalone and desktop packaging, identity checks, framed protobuf transport, and local ephemeral supervision. Verify by preserving all package-boundary tests and adding the cleanup capability to their assertions.
2. **Cleanup uses a dedicated short-lived `--resource-cleanup` process, not the shared watcher connection.** This is an explicit restricted mode, not an unforgeable local-host security boundary: the same-user remote-agent binary can be manually invoked wherever installed. The verified process is established before teardown, kept alive through discovery/finalize proof, and closed after its bounded batch or when no cleanup request is needed.
3. **Normal cleanup plans are not purge jobs.** Add a focused operation ledger for direct deletion; do not reactivate queued retention runs or create `purge_jobs`. Verify with repository tests asserting no purge job is created.
4. **Plain resources include thread attachments/provider logs/terminal history and project memory/notes/kanban only.** Worktrees and checkpoints stay on their current TypeScript paths. Verify by an exhaustive resource-kind partition test.
5. **One resource is processed at a time.** Current cleanup concurrency is `1`; preserve it initially for predictable disk and lock pressure. A later measured change may add bounded concurrency.
6. **No user-facing progress API is added.** Existing deletion command outcomes remain terminal domain outcomes. Cleanup retry state is operational state exposed through structured logs and tests, not a new retention UI.
7. **The cleanup support matrix matches current locally packaged workspace-agent targets:** macOS arm64/x64, Linux x64, and Windows x64. Unsupported standalone architectures fail deletion closed before teardown. Linux arm64 cleanup requires a separately planned local artifact before it can be claimed supported.

## Scope

### In Scope

- An explicit cleanup-mode-only Rust capability in `bigbud-remote-agent`.
- A versioned protobuf request/result contract and TypeScript codec/client.
- Exact, bigint-safe resource identities for new direct cleanup plans.
- Durable TypeScript-owned plan preparation, committed-finalize proof, leases, retry scheduling, and terminal results.
- Direct replacement for supported plain resources in normal thread, retention-triggered thread, and project deletion.
- Descriptor/handle-based removal and quarantine resume for the explicit support matrix.
- Startup reconciliation of canonical thread/project deletion intents, including intents that crashed before cleanup-plan creation.
- Packaging, diagnostics, recovery, and regression coverage.

### Out Of Scope

- Retention cutoff, eligibility, candidate selection, or settling fixes.
- Managed worktree removal, Git worktree metadata, checkpoints, checkpoint references, or legacy purge manifests.
- Provider, browser, terminal, shell, PTY, or process-tree teardown.
- Rust-owned SQLite, queues, journals, eligibility, retries, or domain outcomes.
- Remote-host cleanup, provider-specific behavior, secure erasure, or a general filesystem-delete API.
- Protection against an actively malicious same-user process continuously racing final directory-entry operations.
- New cleanup UI, normal purge jobs, or reactivation of retired retention-run APIs.

### Behavior That Must Remain Unchanged

- Shared attachments are retained.
- Replacement resources, changed roots/parents, and unsafe paths fail closed.
- Canonical deletion commits before external resources are irreversibly removed.
- Missing resources are idempotent success, not deletion failure.
- Worktree and checkpoint behavior remains byte-for-byte on the existing path in this slice.
- A canonical thread/project deletion remains successful even when its external cleanup is pending retry.
- Empty/retained-only Rust plans send no cleanup request; the verified pre-teardown Rust process is closed after discovery. Worktree-only cleanup remains on the existing TypeScript worktree path.

## Repository Findings And Reuse Targets

- Reuse resource discovery and ownership logic in `EntityPurge.assets.ts`, `EntityPurge.logs.ts`, `ThreadDeletion.files.ts`, and `ProjectDeletion.files.ts`.
- Reuse lexical path validation and managed-root mapping from `EntityPurge.resources.ts`, but introduce a direct-cleanup identity model instead of changing persisted legacy purge manifest types.
- Reuse `RemoteAgentConnection`, protobuf framing, hello negotiation, request IDs, frame limits, stderr tail limits, and binary verification under `apps/server/src/remote-agent/`.
- Extend `protocol/remote-agent/` and generated `bigbud-protocol` bindings; do not hand-edit generated output.
- Reuse the existing `bigbud-remote-agent` packaging/build/release path rather than introducing a second native executable.
- Reuse the orchestration receipt payload-digest and `readEventsByCommandId` proof patterns; command ID alone is not sufficient execution proof.
- Follow migration registration in `apps/server/src/persistence/Migrations.ts`; the next migration after the inspected commit is `108`.
- Follow Effect service/layer patterns and direct imports. Keep every materially edited source/test file at or below 400 lines.
- Preserve the legacy `EntityPurge` implementation for manual recovery. Its tests remain regression coverage but are not converted in this slice.

## Cleanup Contract

### TypeScript-Owned Durable Plan

Each plan and its normalized per-resource rows contain:

- Stable deterministic `operationId`, deletion-intent/event ID, entity kind/ID, expected finalize command ID, finalize payload-digest version/digest, expected aggregate/event facts, immutable verified finalize-proof snapshot, plan digest, timestamps, lease/retry state, and attempt count.
- An ordered bounded list of resources with an opaque resource ID, managed root kind, relative path, safe quarantine name, action, type, exact resource/root/parent identity, and expected platform.
- Per-resource terminal or retryable result records. Persist codes and redacted details, never full sensitive paths in logs.

Store bigint filesystem identity fields as canonical unsigned decimal strings. Unix identity is device, inode, and object type; Windows identity is volume serial, file ID, and object type. Root and parent use the same platform-specific stable identity. Mutable timestamps and sizes are diagnostics/content-change policy only, not replacement identity. Use Node bigint/native-handle data for the new direct-cleanup model so IDs are not rounded through JavaScript numbers. Do not rewrite legacy purge-manifest identities in this task.

### Rust Request

After hello, TypeScript bootstraps a bounded non-overlapping managed-root table and Rust returns opaque root handles for this process. The cleanup request contains a request ID, stable operation ID, plan/page digest, deadline, and resources referencing only those handles. Rust rejects forbidden roots, duplicate/overlapping roots, absolute resource paths, and roots whose identity changed. It treats every field as untrusted and accepts cleanup frames only in `--resource-cleanup` mode.

### Per-Resource Outcomes

- `removed`: the captured object was quarantined and removed.
- `already_absent`: neither the original nor matching quarantine exists.
- `resumed_and_removed`: a matching quarantine from an earlier ambiguous attempt was removed.
- `retained_shared`: TypeScript explicitly excluded it from execution; this is recorded by TypeScript and is not sent to Rust.
- `identity_mismatch`: a root, parent, target, or quarantine no longer matches; terminal and retained for safety.
- `unsupported_entry`: a detected mount/reparse/special entry cannot be safely traversed; terminal and retained.
- `busy`, `permission_denied`, `deadline_exceeded`, `io_failure`, `process_failure`, `protocol_failure`: retryable according to TypeScript policy.

Rust never decides whether a retry occurs or whether deletion succeeded as a product operation.

## Implementation Steps

### 1. Record The Boundary

1. Add a focused ADR under `docs/decisions/` documenting the direct-replacement decision, explicit cleanup-mode authority profile, TypeScript operation ledger, no-fallback behavior, bounded same-user threat model, support matrix, and exclusions.
2. Update `docs/RUST_SYSTEMS_CORE.md` only where necessary to list direct resource cleanup as an implemented/approved systems slice; retain the rule that Rust is not a canonical authority.
3. Define explicit invariants: deterministic deletion-intent identity, plan-before-finalize, receipt-payload-and-event proof before execute, stable digest, one active TypeScript lease plus one executor-side OS lock, no blind replay after ambiguity, and no deliberate traversal through links/detected mounts/reparse points.

### 2. Add The Durable Direct-Cleanup Ledger

1. Add `apps/server/src/persistence/Migrations/108_DirectResourceCleanupPlans.ts`, import it in `Migrations.ts`, and append migration entry `108`.
2. Create focused deletion-intent, plan, per-resource/result, proof-snapshot, and page-attempt tables. Constrain entity kinds, states, nonnegative attempts, unique finalize command IDs, immutable operation/digest identity, lease consistency, and terminal timestamps. Index intent recovery and ready/retry lookup; do not store one unbounded manifest JSON blob.
3. Add `Services/DirectResourceCleanupRepository.ts` and `Layers/DirectResourceCleanupRepository.ts`, split by prepare/claim/result/recovery concern if needed.
4. Implement idempotent `prepare`, `markFinalizeCommitted`, `cancelPrepared`, `claimReady`, `recordResults`, `scheduleRetry`, `block`, and `complete` operations. All compare operation ID and digest; stale leases cannot commit results.
5. Make initial execution eligibility require an accepted receipt matching finalize command ID, payload digest version/digest, aggregate kind/ID, expected mode/thread IDs, and a committed expected deletion event from `readEventsByCommandId`. Atomically store an immutable proof snapshot containing those verified facts, event ID/sequence/type, and normalized payload.
6. Require the ordering `finalize commit -> verify receipt/event -> persist proof snapshot -> canonical history cleanup -> Rust execution`. If proof persistence fails, defer canonical pruning and Rust execution. Recovery may query canonical records while present, but after pruning it relies only on the immutable snapshot.
7. Bound each persisted path/identity field and every Rust request to 256 resources/frame limits. Give every resource an immutable original index and fixed page ordinal. Persist the exact resource set, request/attempt ID, and digest before send; replay an ambiguous attempt byte-for-byte. After a known response is atomically recorded, create a new attempt identity for retryable failed rows only. Do not impose a new undocumented total resource limit.
8. Add migration and repository tests for constraints, duplicate prepare, same-ID/different-digest conflict, proof mismatch/snapshot, stale leases, retry ordering, immutable page attempts, crash states, and post-pruning recovery.

### 3. Separate Plain Resources From TypeScript-Only Resources

1. Add a direct-cleanup resource model beside `ThreadDeletion.files.ts`/`ProjectDeletion.files.ts`, using decimal-string bigint identities and existing managed-root/path validation.
2. Partition thread resources exhaustively: attachments, provider logs, and terminal history become Rust-plan resources; managed worktrees remain in the current TypeScript executor. Retained shared attachments are persisted as retained outcomes and never sent to Rust.
3. Convert all project memory, notes, and kanban resources to Rust-plan resources.
4. Persist a direct-deletion intent atomically in the same projection transaction that materializes each `thread.deletion-requested`/project deletion-request event and `deletingAt`. Store event ID, source command ID/digest, entity, mode, and deletion timestamp; retain it through plan completion so startup never scans full event history.
5. Derive operation and finalize command IDs deterministically from that durable intent identity. Persist the normalized finalize payload and its canonical receipt digest before dispatching `thread.delete.finalize` or `project.delete.finalize`.
6. On deterministic abort before finalize commit, cancel the prepared plan and close the intent. On an ambiguous finalize result, leave both prepared; deletion-intent recovery redispatches the exact same command ID/payload only after querying its receipt.
7. After confirmed finalize commit, snapshot proof before `finalizeThreadCanonicalHistory`, then attempt cleanup immediately through the durable coordinator. Do not turn filesystem failure into domain deletion failure; persist retry/block state and retain the existing factual warning.
8. Remove `deleteResourceAtomically`/`removeWithoutFollowingSymlinks` use only for supported normal-path plain resources. Keep those functions for managed worktrees and legacy manual recovery.

### 4. Extend The Versioned Protocol

1. Add `protocol/remote-agent/resource_cleanup.proto` with cleanup request, resource identity, resource result, batch response, and typed error enums; add new unused field numbers to `v1.proto`.
2. Increment the compatible protocol minor version and advertise `resource.cleanup` capability version `1` only in resource-cleanup mode.
3. Regenerate Rust protocol types through `bigbud-protocol/build.rs`; update TypeScript protocol types/codecs and golden frames.
4. Require request ID, operation ID, plan/page digest, deadline, platform, bootstrapped root handle, bounded resource count, and unique resource IDs. Reject malformed decimal identities, duplicate IDs, overlapping/forbidden roots, oversized frames, unsupported action/type, and incompatible platform before mutation.
5. Add cross-language golden tests for every outcome and malformed/oversized/truncated frames.

### 5. Implement The Rust Primitive

1. Add a focused `resource_cleanup/` capability under `crates/bigbud-remote-agent/src/`, with small platform-neutral contract/validation modules and `cfg`-gated Unix and Windows executors.
2. Add `--resource-cleanup` in `main.rs`. This mode performs normal hello negotiation but accepts only root-bootstrap and cleanup frames, has no remote journal, opens no network/socket authority, and exits on stdin closure or bounded idle timeout.
3. Add an implementation-first platform feasibility harness before integrating handlers. It must prove each platform algorithm against real races and record unavailable primitives as fail-closed capability errors; no platform enters the supported matrix from compile success alone.
4. On Unix, reuse `libc`. Open the managed root and path components with descriptors/no-follow flags; compare descriptor metadata; take an operation/resource `flock`; quarantine with parent-relative rename; verify quarantine identity after rename and again before irreversible mutation; enumerate/unlink relative to held descriptors. Use Linux mount IDs where available and macOS filesystem IDs to refuse detected boundary changes. A same-user final-name race may cause a temporary wrong-object rename, but post-rename identity mismatch must prevent its removal and attempt restoration.
5. On Windows, add the user-approved target-specific `windows-sys = 0.61.2` with only required Foundation, FileSystem, IO, and Security features. Open roots/parents/targets with reparse-point-safe flags and delete sharing; verify volume/file IDs/type from handles; hold an exclusive operation lock; rename/delete through verified handles where supported; delete a reparse point itself without traversing it.
6. Treat children inserted inside the held quarantined directory as owned by that quarantined resource, but never deliberately follow symbolic links, junctions, reparse points, or detected mount boundaries. Reject unsupported special files.
7. Resume only when the original target is absent and the stable quarantine object matches the captured identity. If both original and quarantine exist, or either is a known replacement, return `identity_mismatch` without irreversible mutation.
8. Check deadline/cancellation between entries. Bound recursion depth, entry count, and known-byte accounting; return partial per-resource outcomes without claiming an unproven removal.
9. Keep safe Rust as the default. Every unavoidable native `unsafe` block gets a local `SAFETY` invariant and focused review/test. Do not log paths or file contents.

### 6. Add The TypeScript Client And Coordinator

1. Generalize the current local workspace-agent binary resolver so deletion and watching share artifact discovery/verification without sharing a live process. Preserve `BIGBUD_LOCAL_WORKSPACE_AGENT_BINARY` compatibility; add a correctly named preferred override only if needed.
2. Add `DirectResourceCleanupExecutor` under `apps/server/src/deletion/Services/` with a live Rust implementation under `Layers/`. It spawns `bigbud-remote-agent --resource-cleanup`, handshakes, bootstraps roots, verifies capability/platform, sends one bounded page at a time, and always closes the child.
3. Add `DirectResourceCleanupCoordinator` to own claiming, immediate execution, retry classification, exponential backoff with jitter/cap, leases/heartbeats, startup recovery, and graceful shutdown. Keep concurrency at one and queues bounded. Rust's OS lock, not the SQLite lease alone, excludes an orphan child still running after server death.
4. Spawn and handshake one cleanup process before provider/browser/terminal/shell teardown for every deletion on a supported architecture, then hold that verified process through teardown, discovery, finalize proof, and immediate execution. Use bounded heartbeats/deadlines while teardown runs. If discovery yields no executable Rust resources, send no cleanup request and close the process. If process establishment or liveness fails before finalization, abort before finalization and cancel any prepared plan; never rely on a stale cached capability result.
5. After canonical finalization, process failures are durable cleanup failures, not domain rollback. Preserve exact operation/digest identity and inspect original/quarantine state on retry.
6. Start the recovery coordinator from the server layer after migrations and persistence are ready. Shutdown stops claims, lets the active bounded request settle or expire its lease, then closes the process.
7. Emit path-free structured diagnostics: operation state, entity kind, resource kind, outcome/error code, attempt, duration, counts, and Rust build/protocol identity.

### 7. Reconcile Canonical Deletion Intents

1. Extract the idempotent thread/project deletion workflow so both hot reactor events and startup reconciliation call the same service; do not rely on replay of `ProviderCommandReactor` events.
2. At startup after projection/bootstrap readiness, read bounded indexed open deletion-intent rows joined to thread/project projections with `deletingAt != null`; never recover through a full event-history scan.
3. If no plan exists, rerun idempotent runtime teardown, rediscover resources while canonical ownership rows remain, and prepare the plan. If a prepared plan exists without a receipt, query the exact finalize command outcome before redispatching the same command payload.
4. If accepted proof matches, persist its immutable snapshot before allowing canonical history pruning or Rust execution. If a deterministic abort/rejection exists, cancel it. If proof is missing or contradictory, retain a blocked operational record and never execute Rust.
5. Cover crashes after deletion-request commit, after teardown, during discovery, after prepare, during finalize, and before immediate cleanup.

### 8. Integrate Thread, Retention, And Project Deletion

1. Update `ThreadDeletionShape` so discovery returns the prepared direct-cleanup plan plus TypeScript-only worktree resources. Keep the deletion fence and preflight APIs unchanged.
2. Update `ProviderCommandReactorHandlers.delete.ts` to use one stable finalize command ID, prepare before dispatch, mark/execute after commit, cancel after proven abort, and leave ambiguous plans for receipt reconciliation.
3. Ensure retention-triggered deletion uses this same provider-command path; do not add a second retention-specific executor.
4. Update `ProviderCommandReactorHandlers.project-delete.ts` with the identical prepare/prove/execute ordering.
5. Preserve terminal history manager teardown before filesystem cleanup. Rust must accept `already_absent` when that manager already removed a captured history file.
6. Keep normal command outcomes and UI payloads unchanged. Cleanup pending/blocked status remains operational and must not resurrect deleted entities.

### 9. Packaging, CI, And Operational Readiness

1. Update `bigbud-protocol/build.rs`, `scripts/lib/workspace-agent-handshake.ts`, `localWorkspaceWatchAgent.binary.ts`, `apps/server/scripts/workspaceAgent.ts`, protocol fixtures, and standalone prepack checks for compatible minor-version negotiation and cleanup-mode capability assertions. Default/ephemeral/proxy modes must not advertise cleanup; cleanup mode must.
2. Keep the existing artifact locations and binary name so Electron and standalone server packaging do not gain a second executable.
3. Update release asset, macOS/Linux/Windows desktop artifact, executable-permission, architecture, code-signature, and smoke tests to exercise `--resource-cleanup` safely in a temporary directory.
4. Make missing/incompatible packaged binaries a clear fail-closed deletion error before finalization. Do not silently fall back to TypeScript.
5. Add native Rust/integration CI jobs for macOS arm64/x64, Linux x64, and Windows x64, and make direct-replacement release eligibility depend on them. Keep privileged mount tests in an explicit environment-capable job.
6. Report Linux arm64 as unsupported for local cleanup until a local packaged artifact and the same native tests exist; do not infer support from remote-agent release assets.

### 10. Remove Only Superseded Normal-Path Code

1. After all conformance and package gates pass, delete the plain-resource branches from normal TypeScript cleanup functions.
2. Retain shared discovery helpers, worktree cleanup, legacy purge recovery, and their safety tests.
3. Search for all `deleteResourceAtomically`, `removeWithoutFollowingSymlinks`, `cleanupDiscoveredThreadDeletionFiles`, and `cleanupDiscoveredProjectDeletionFiles` consumers and prove each remaining consumer is intentionally out of scope.
4. Update code comments and names so no module implies all deletion is Rust-owned.

## Validation Plan

### Focused Rust Tests

- Identity match/mismatch, missing target, stable-quarantine resume, collision, file and nested directory removal.
- Symlink child, symlink ancestor, junction/reparse point, root/parent replacement, target replacement before open, replacement after open, and concurrent child insertion/removal.
- Detected mount/cross-device refusal, special-file refusal, recursion/entry/deadline bounds, cancellation, OS-lock contention/orphan parent, duplicate operation/digest, and partial result reporting.
- Platform-gated real filesystem tests on macOS, Linux, and Windows; Windows tests must include junctions and open-handle sharing behavior.
- Protocol malformed frame, oversized frame, wrong mode/capability, wrong platform, duplicate resource ID, and process-exit tests.

### Focused TypeScript Tests

- Migration/repository tests for every state transition and crash window.
- Resource partition tests proving only the six approved kinds reach Rust and worktrees/checkpoints never do.
- Handler tests proving atomic intent projection, plan-before-finalize, exact finalize command receipt/event proof snapshot before canonical pruning, abort cancellation, ambiguous outcome reconciliation, immediate execution, and durable retry.
- Startup reconciler tests for deletion intent with no plan, prepared plan with no receipt, accepted matching/mismatching receipt/event proof, recovery after canonical pruning, and deterministic abort.
- Real-process integration test against a built local agent in a temporary tree.
- Regression tests proving active/pinned/shared/worktree behavior and user-visible deletion outcomes do not change.
- Mass retention and delete-now tests proving every selected thread prepares a plan and filesystem failures do not stall candidate selection.

### Failure Matrix

Exercise crashes at: after atomic deletion-intent projection/before reactor delivery, before plan insert, after plan insert/before finalize, during finalize, after accepted receipt/before proof snapshot, after proof snapshot/before canonical pruning, after pruning/before Rust accept, after quarantine rename, during traversal, after removal/before response, after response/before SQLite result commit, and during server shutdown. Also kill the server while Rust keeps the OS lock, expire the SQLite lease, and start a second coordinator. Ambiguous page attempts must replay the identical persisted resource set/digest. Each case must result in safe intent reconstruction, no mutation, deterministic resume, or an explicit blocked record.

### Required Commands

```sh
bun run --cwd apps/server vitest run <focused deletion/protocol/persistence test files>
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
bun fmt
bun lint
bun typecheck
bun run test
```

Never run `bun test`. Run packaged server/desktop supervisor smoke and artifact-verification commands affected by workspace-agent protocol/packaging changes.

### Completion Evidence

- Test output for the full command set and platform CI matrix.
- Fault-injection table mapping every crash point to its recovered state/outcome.
- Package smoke evidence for supported macOS, Linux, and Windows targets.
- Search evidence that normal supported plain resources have no TypeScript deletion fallback.
- Structured diagnostic sample containing no precise paths or content.

## Risks And Rollout

- **Native API complexity:** Keep platform modules small, review every unsafe block, run the feasibility harness first, and gate each platform on real native tests rather than path-mocking alone.
- **Ambiguous process failure:** Persist the plan before finalization and retry only with the same operation ID, digest, identity, and quarantine name.
- **Canonical/resource ordering:** Never execute without an accepted finalize receipt. Never remove before canonical commit.
- **Canonical proof pruning:** Snapshot verified receipt/event facts before canonical cleanup removes them; proof persistence failure defers pruning and execution.
- **Binary unavailable:** Fail new deletion closed before finalization. Already-finalized plans remain pending until a compatible binary is restored.
- **Identity portability:** Use decimal-string bigint identities and platform-specific handle metadata; do not compare rounded JavaScript numbers.
- **Large cleanup sets:** Bound request pages and execute sequentially. The durable plan, not memory, is the source of retry state.
- **Pre-plan crashes:** Startup reconciliation uses atomically projected indexed deletion intents and deterministic IDs to reconstruct the obligation before canonical ownership rows disappear.
- **Orphan executor overlap:** Per-operation/resource OS locks survive only with the process and exclude a restarted coordinator while an orphan child still executes.
- **Direct replacement rollback:** Roll back application code and binary together. The ledger is additive and must be retained; older code may ignore pending rows but must not delete them. A corrective release can resume them.
- **Legacy divergence:** Do not partially port legacy purge jobs. Their manual recovery path remains TypeScript until a separate plan proves value.
- **Observability/privacy:** Record codes/counts/timings only. Never log full resource paths, file names, or contents.

No percentage rollout or TypeScript fallback is planned. Release only after the explicit supported platform matrix passes because direct replacement makes binary compatibility a deletion prerequisite. Outside that matrix, deletion fails closed before teardown rather than using the old plain-resource executor.

## Plan Validity

This plan describes branch `main` at `e39d7b291e727f18b3400f24274417200132af20` with a clean initial worktree, Rust `1.95.0`, remote-agent protocol/packaging as inspected, and migrations through `107`.

Revalidate this plan before implementation if any of the following changes:

- Migration `108` is claimed.
- Normal deletion no longer flows through the inspected thread/project handlers.
- `PurgeResource` identity or managed-root mappings change.
- The workspace-agent binary, protocol major, packaging location, or local watcher ownership changes.
- A supported platform/architecture is added or removed.
- Rust deletion support, fallback policy, worktree/checkpoint scope, or SQLite ownership is reconsidered.

## Handoff Notes

Recommended order: ADR/threat model, atomic deletion-intent/cleanup ledger and proof-snapshot tests, deletion-intent reconciliation, protocol schema/codecs, native feasibility harness, Rust primitive, TypeScript client/coordinator, handler integration, native CI/packaging, then removal of superseded normal-path branches.

Settled decisions the implementing agent must not reopen without new evidence:

- TypeScript owns all domain semantics, SQLite, eligibility, plans, retries, and final outcomes.
- Rust owns only approved local filesystem plan execution.
- The first slice covers plain thread/project resources only.
- Supported plain resources use Rust as a direct replacement with no TypeScript fallback.
- Worktrees, checkpoints, runtime teardown, and legacy purge recovery remain TypeScript-owned.
- Reuse `bigbud-remote-agent` as a dedicated short-lived explicit cleanup-mode process.
- `windows-sys 0.61.2` is approved as a narrowly featured target-specific direct dependency.
- Initial support is macOS arm64/x64, Linux x64, and Windows x64; unsupported architectures fail closed.

No remaining product or architecture blocker prevents implementation. Platform release remains gated on the validation evidence above.
