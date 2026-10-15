# Dead thread recovery: OpenCode V2 dead-backend retirement, in-place recovery, fork fallback

**Date:** 15 October, 2026
**Status:** In progress (Phase 1 implemented in staging worktree `fix/dead-thread-recovery`; Phases 2–3 pending)
**Owner:** bigbud server/provider maintainers (implementation agent on branch `fix/dead-thread-recovery`)

**Inspected tree:** worktree `.claude/worktrees/dead-thread-recovery`, branch `fix/dead-thread-recovery` at `228464334` (clean). The guide's status list has no "Ready for implementation"; the requester asked for it explicitly, so it is used here and replaced by "In progress"/"Implemented" as phases land.

## Summary

A "dead thread" is a thread whose provider session can no longer accept turns. Today every send on such a thread fails until the user abandons it. The worst case is OpenCode V2: after any backend restart that did not detach thread tools (crash, kill, dev-watcher reload, normal shutdown), every later send on that thread fails forever with "V2 previous owner retirement is not durably physically settled; no replacement or history replay." This plan fixes that in three independently shippable phases:

1. **OpenCode V2 dead-backend recovery.** A backend that holds the state-directory lock proves that the backend which enrolled a thread is dead. It then retires that enrollment with a new, versioned proof kind and continues the send. Normal shutdown detaches thread tools within a bounded deadline. This unblocks the user's four stuck threads without loosening any rule for live owners.
2. **Generic in-place recovery for every provider.** Turn-start failures get a typed classification. On `session-dead` the server tries once to revive the session, then once to start a fresh session in the same thread with transcript replay. The bug that skips transcript replay when the new message has attachments is fixed. After 5 s the UI shows "Reconnecting…".
3. **Fork as the final fallback.** A server-side, idempotent `thread.fork` command copies messages, activities, plans and tasks, records the fork point and reason, and carries the pending message across. It runs automatically only when in-place recovery is impossible, and manually from "Continue in a new thread".

## Related Work

- Bigbud note / Kanban card: None identified. The request came from conversation; recording a card is an open question.
- [OpenCode V2 gap closure plan](2026-10-15-opencode-v2-gap-closure-plan.md) (Phase 2 introduced the backend instance lock this plan builds on) and its ledgers: [gap closure final](../validation/opencode-v2-gap-closure-final-2026-10-15.md) (lock start-token fixes; open decision on CLI maintenance and the lock), [live-send diagnosis](../validation/opencode-v2-live-send-diagnosis-2026-10-15.md), [reboot recovery](../validation/opencode-v2-reboot-recovery-2026-10-14.md), [cross-platform recovery](../validation/opencode-v2-cross-platform-recovery-2026-10-14.md).
- Provider contract: [providers-opencode-v2.md](../reports/providers-opencode-v2.md) (lines 66 and 76: no native fork, no transparent process-loss recovery, never replay uncertain work).
- Lineage and deletion: [thread FK ownership matrix](2026-08-18-thread-fk-ownership-matrix.md) (Phase 3 lineage columns must be added to it).

## Problem

Observed facts (verified 2026-10-15 in this worktree and read-only in `~/.bigbud/dev`):

1. **The send path only accepts settled retirement.** `apps/server/src/provider/Layers/OpencodeV2/Orchestration.enrollment.retirement.ts:174-202` (`assertSettled`) needs a retirement in phase `settled`/`replacement-bound` with native detach evidence and a `proved()` proof (`:54-70`, exactly six true flags, or `receiptsSettled:false` plus a reboot checkpoint digest), or a valid reboot seal. It is reached from two places. The first is `Application.orchestration.lazy.ts:52-57` → `Orchestration.enrollment.recovery.ts:16-43` (`assertV2PreviousHistoryRetired`, called by `Runtime.sessions.ts:147-153` before any shared history is touched). The second is `Orchestration.enrollment.ts:226-252` (`startExclusive`) → `recovery.ts:46-98` (`recoverV2PreviousEnrollment`). For a non-revoked saved enrollment that path only asserts. For a revoked one it runs begin → inspect → detach → acknowledge but never `settle`.
2. **Only in-process cleanup settles.** `detachV2Enrollment` (`Orchestration.enrollment.detach.ts:19-85`) settles with `v2BridgeRetirementProof` (`Orchestration.bridge.activation.ts:72-98`). It is called only from session cleanup (`Orchestration.bridge.ts:206-216` via `Runtime.preparation.ts:51-63`), bootstrap replacement (`Orchestration.bridge.ts:226-259`) and activation retirement (`bridge.activation.ts:135-145`). `V2ThreadBridge.close()` (`Orchestration.bridge.ts:360-362`) only revokes. `OpencodeV2Runtime.close()` (`Runtime.ts:384-396`) aborts starts and drains teardown but never detaches live sessions. So every shutdown, crash or reload leaves enrollments `active` with no retirement record. The only designed escape is the manual reboot checkpoint (`RebootRecovery.*`, `V2EnrollmentRetirement.stageReboot`).
3. **User data.** `~/.bigbud/dev/opencode-v2-thread-tools/` holds 5 enrollments, all `active`. Two use `bigbud.thread.v1` (written 2026-10-13 17:12 and 10-14 01:27); their retirements are in phase `reboot-prepared`. Two use `enrollment.v2` (10-15 00:33/00:34) and have no retirement. One belongs to the current backend (last written 10:27). There are 7 receipts: 6 `completed` and 1 `reserved` (10-14 01:27). The reboot checkpoint fences that reserved receipt. A reboot settlement seal exists (settled 2026-10-14T12:49:46Z) and its host `bootSeconds` equals the current `kern.boottime` (1791979909). **This is new evidence:** the reboot path may already settle the two v1 threads. If so, the threads that fail are the two `enrollment.v2` threads plus any thread the current backend leaves behind at its next restart. The plan does not depend on this: Phase 1 supersedes a stalled reboot retirement only when its proof actually fails.
4. **Receipt evidence is global.** `v2RebootReceiptEvidence` (`RebootRecovery.proof.ts:92-110`) scans _all_ receipts. Receipt filenames are `sha256(JSON.stringify([storageIdentity, turnId, nativeSessionId, messageID, callID]))` (`Orchestration.bridge.invoke.ts:50-57`, `Orchestration.records.ts` `filename`), so a receipt cannot be attributed to a thread without its key. One `reserved` receipt that no reboot checkpoint fences makes `proved()` false for every retirement. A dead backend that dies mid tool call therefore blocks all later live settlements.
5. **The backend instance lock exists but is not visible to providers.** `apps/server/src/startup/stateDirLock.ts:193-252` creates `<stateDir>/backend.lock` exclusively with a random `nonce`, `pid` and a comparable start token (`utils/processStartToken.ts`). `classifyStateDirLockOwner` (`:91-101`) proves death. `StateDirLockLive` (`:255-274`) is `Layer.effectDiscard` and exposes nothing; `server.ts:363` provides it under the whole runtime. Thread-tool records live under `<stateDir>/opencode-v2-thread-tools` (`Orchestration.storage.ts:124`), so whoever holds the lock is the only live backend that can own them.
6. **Generic failures are free text.** `recordTurnStartFailure` (`orchestration/Layers/ProviderCommandReactorHandlers.failures.ts:56-78`) stores `context` plus free-text `detail` (`packages/contracts/src/orchestration/orchestration.events.thread.ts:187-192`, `orchestration.commands.internal.ts:106-113`). Classification is regex-only: busy at `ProviderCommandReactorHandlers.turnStart.ts:21-33`, context-limit at `ProviderCommandReactorSessionOps.recovery.ts:8-24`. The only in-place recovery is `withOneShotContextLimitRecovery` (`recovery.ts:95-113`), wired in `sendTurnForThread` (`ProviderCommandReactorSessionOps.ts:228-249`). Typed errors that could say "session dead" already exist (`provider/Errors.ts:25,41,74`: `ProviderAdapterSessionNotFoundError`, `ProviderAdapterSessionClosedError`, `ProviderAdapterProcessError`) but are not used to classify.
7. **Transcript replay is skipped for messages with attachments.** See `ProviderCommandReactorSessionOps.context.ts:12,20`. After a session loss, a message with an image starts a fresh provider session with no history.
8. **Branching is client-only and lossy.** `apps/web/src/hooks/useThreadActions.ts:160-319` dispatches `thread.create` with copied message text and attachments (`apps/web/src/lib/threadBranch.ts:157-227`; cap of 200 enforced on the client and on the server at `deciderThreads.lifecycle.ts:31,132-137`). It does not copy activities, plans or tasks, records no fork point, and has no idempotency. Lineage is only `ParentThreadReference {threadId,title,projectId?}` (`orchestration.thread.ts:82-88`). `conversationFork` (`provider/Services/ProviderAdapter.ts:73`) has no consumer.

Impact: users lose access to long threads after any backend restart (V2) or provider process loss (all providers). The only workaround is a manual branch, which drops the work log, plans and tasks.

## Goals

- G1. After a crash, kill, reload or normal restart, the next send on an OpenCode V2 thread succeeds when the native session is idle. The user's stuck threads become sendable after upgrade with no manual steps. Nothing uncertain is replayed.
- G2. When the native session is still running a turn started by a dead backend, the send is refused with an actionable message. Live owners keep exactly today's proof rules.
- G3. Normal shutdown detaches V2 thread tools within a bounded deadline, so the dead-backend path is the exception rather than the norm.
- G4. Every turn-start failure carries a typed class. A `session-dead` failure on any provider gets at most one revive and one fresh-session-with-replay attempt in the same thread. The transcript is replayed even when the message has attachments.
- G5. When in-place recovery is impossible or fails, the thread continues in a fork that preserves messages, activities, plans and tasks, records lineage (source, fork point, reason), is idempotent, and receives the pending message.
- G6. The UI shows recovery progress after 5 s and offers "Continue in a new thread", with AGENTS.md colors (blue working, green done, amber warning, red failure).

## Non-Goals

- Native OpenCode fork, rewind or transparent process-loss recovery (forbidden by the V2 contract), and native history deletion.
- Interrupting a native OpenCode turn started by a dead backend (the user does this in OpenCode; possible follow-up).
- Changing `V2ThreadOwner` (the signed, plugin-visible owner material), the native plugin protocol, `proved()` rules for live owners, or the reboot checkpoint design.
- Cross-provider automatic failover. An automatic fork never changes provider.
- LLM-summary handoff changes (`apps/server/src/ws/wsHandoffJobs*.ts`); the summary handoff stays as it is.
- CLI maintenance commands taking the lock (open in the gap-closure final ledger). Without the lock they simply cannot run dead-backend recovery.

## Current State

See Problem for line references. More context:

- Records: `V2ThreadRecords` (`Orchestration.records.ts`) stores signed (ed25519, persistent issuer from `openV2ThreadIssuer`, `Orchestration.storage.ts:123-155`) conditional-revision records. Sibling namespaces are a closed union (`records.ts:34-56`). The issuer is stable across restarts, so a new backend can sign `inspect`/`detach` cleanup envelopes for an old owner (`Orchestration.enrollment.record.ts:41-61`, legacy v1 included).
- Native evidence: `validateV2LeaseInspection` and `validateV2DetachAcknowledgement` (`Orchestration.enrollment.ack.ts:13-68`) accept the exact retained lease (`active|expired|revoked`) or registry absence (`missing|revoked` with 0/0). `client.session.active()` lists sessions with a running foreground drain; "Sessions absent from the result are inactive" (`SharedService.official.ndjson:6`). It is used in `Runtime.inspect.ts:31`, `Orchestration.bridge.activation.ts:29` and elsewhere.
- Composition: `Application.composition.ts:124-131` builds `makeV2RequiredOrchestration` and adds `orchestration.close()` as a scope finalizer. The adapter finalizer (`Adapter.runtime.ts:111-112`) calls `runtime.close()` first, because finalizers run in reverse order. `Effect.serviceOption` is already used there for optional services (`:44,52`).
- Tests that must stay green unchanged: `Orchestration.enrollment.foreign.test.ts`, `Orchestration.enrollment.foreign.process.test.ts` (a lockless foreign reader must stay blocked), `Orchestration.enrollment.retirement.test.ts`, `Orchestration.enrollment.retirement.crash.test.ts`, `Orchestration.enrollment.concurrent.test.ts`, `RebootRecovery*.test.ts`, `startup/stateDirLock.test.ts`. A realistic harness exists: `Orchestration.production.fixture.ts` (`withV2ProductionThreadTools`: real listener, enrollment, receipts, canonical HTTP/SQLite).
- Generic recovery: `ProviderServiceSessionRouting.ts:56-170` recovers a binding using `sessionRecovery` (`resume-restart` for Claude, OpenCode V2 (`Adapter.capabilities.ts:8`) and others; `fresh-restart` for CliProxy). The session start timeout is 45 s (`ProviderService.startSession.ts:20`). `buildResumedTurnInput` (`ProviderCommandReactorHelpers.ts:201-236`) already drops the uncertain last turn. The budget is `PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000`.
- Web: `thread.turn-start-failed` sets session `error` (`apps/web/src/stores/main/events.store.threads.runtime.ts:212-235`). Toasts come from `apps/web/src/components/ui/toast*.ts(x)`. Attachment purge keeps files still referenced by another thread (`deletion/Layers/EntityPurge.claims.ts:245`, test "keeps an attachment referenced by a retained thread" in `EntityPurge.security.test.ts:84`).
- File-length pressure (400-line limit): `Runtime.ts` 397, `Orchestration.enrollment.ts` 379, `Orchestration.bridge.ts` 363, `Application.composition.ts` 370, `deciderThreads.lifecycle.ts` 377, `Migrations.ts` 288. New logic goes into new dot-notation modules.

## Decisions

- **D1. Owner-instance marker in a new signed namespace.** The marker lives in a new namespace `instances`, as record `owner:<ownerDigest>` → `{format:"bigbud.thread.backend-owner.v1", ownerDigest, enrollmentNonce, backendInstance, pid, startedAt, hostname}`. `V2ThreadEnrollment.startExclusive` writes it before the first `persist()` of a new enrollment. Rejected: adding a field to `V2ThreadOwner`, which changes the signed digest and the native plugin wire format; adding a field to the enrollment record, which `decodeV2EnrollmentRecord` decodes strictly (`record.ts:28-34`), so a rollback would make records undecodable. Older builds ignore the new namespace. Missing marker (legacy) = foreign.
- **D2. `BackendInstance` service.** `StateDirLockLive` becomes `Layer.effect` providing `BackendInstance {nonce, pid, startedAt, hostname, stateDir, lockPath, assertHeld()}`. `assertHeld` re-reads `backend.lock` and requires parseable content with an equal nonce, pid and hostname. V2 composition reads it with `Effect.serviceOption`. If it is absent (tests, harnesses, CLI), or the thread-tools root's realpath is not `<stateDir>/opencode-v2-thread-tools`, dead-backend recovery is disabled and today's behavior is kept (fail closed).
- **D3. Foreign-owner proof.** An owner is dead when all three hold. (a) `assertHeld()` passes. (b) The marker is missing, or its `backendInstance` differs from ours _and_ `classifyStateDirLockOwner({pid,startedAt,hostname,...})` returns `dead`. This second check is defense in depth against a manually deleted lock while the old backend still runs. A marker with our own nonce means our own owner: the normal path, unchanged. (c) The exact native session is absent from `session.active()`. If the probe errors, recovery is refused.
- **D4. New versioned proof kind; live rules untouched.** `V2DeadBackendRetirementProof = {kind:"bigbud.thread.retirement-proof.owner-backend-dead.v1", settlingBackendInstance, settlingPid, ownerBackendInstance: string|null, nativeInactiveObservedAt, receiptFenceDigest, receiptsSettled, supersededRebootCheckpointDigest?}`. It is validated by an exact-key `provedDeadBackend()` in a new module. `proved()` is unchanged. `settle`/`assertSettled` accept `proved(p) || provedDeadBackend(p)`. For the dead-backend kind, `verifyReceiptProof` re-reads and verifies the signed fence by digest. Older builds fail closed on these records (thread blocked again), never open.
- **D5. Per-instance receipt fence instead of rewriting receipts.** At the first `makeV2ApplicationOrchestration` of a backend instance, before the bridge exists, the server writes the signed record `instances/fence:<nonce>` = `{format:"bigbud.thread.receipt-fence.v1", backendInstance, receipts:[{name, digest}] of every reserved receipt}`. Later opens with the same nonce reuse it. Any reserved receipt from a dead backend is therefore in this fence or the reboot fence, and any reserved receipt outside both was reserved by this instance. Receipts are never rewritten; `V2ThreadReceipts.find` already refuses to replay `reserved` (`Orchestration.receipts.ts:41-51`). Their outcome is "unknown, preserved, no replay", the same meaning as the reboot seal. If writing the fence fails, dead-backend recovery is disabled.
- **D6. One recovery function, two entry points.** New `Orchestration.enrollment.deadBackend.ts` exports `retireV2DeadBackendEnrollment`. The flow: try `assertSettled`; on failure check D3; persist the enrollment as `revoked` (conditional on the saved revision, same order as `detach.ts:52-54`); `begin` → `inspect` → `detach` → `acknowledge` (reusing the validators); `settle(deadProof)`; `assertSettled`. Callers are `assertV2PreviousHistoryRetired` and `recoverV2PreviousEnrollment` (both branches). The `beforeSharedHistory` scope (`Runtime.types.ts:100-105`) gains `client` and `transport` (`config.sharedService.registrationFile`). `V2EnrollmentOptions` gains an optional `deadBackend` context (`BackendInstance`, fence, `nativeSessionActive` probe). All native calls run under `runV2Cleanup` with a 15 s deadline (`runWithAbortableDeadline`). Concurrent sends are serialized by the conditional record revisions and the idempotent `begin`.
- **D7. Absent or expired native lease is accepted only with an answer.** Native state is accepted only as the existing validators allow: exact-entry or registry-absent. A transport error, a missing plugin, or a mismatched lease means refusal. No proof is ever written without a native answer.
- **D8. Reboot supersession only when the reboot proof fails.** In `assertSettled`, if `assertV2RebootRetirement` throws and D3 holds, the new `supersedeStalledReboot(identity)` rewrites the record conditionally on its revision. The phase becomes `retiring`, `rebootCheckpointDigest` moves to `supersededRebootCheckpointDigest` (otherwise `:177-183` would later reject the detach/proof), and the archived enrollment is unchanged. Recovery then continues as in D6. Checkpoint and seal records are never touched. A valid reboot proof always wins.
- **D9. User-facing refusal texts** keep the "V2 " prefix so the existing surfacing passes them through verbatim:
  - Native session active: "V2 OpenCode is still running a turn on this thread that was started before bigbud restarted. Let it finish or stop it in OpenCode, then send again; nothing was replayed."
  - Previous backend alive: "V2 the previous bigbud backend for this thread (pid N) is still running; stop it, then send again."
  - Lock unprovable: "V2 cannot prove the previous bigbud backend exited (backend lock not held by this process); restart bigbud. Nothing was replayed."
  - Native unconfirmed: "V2 OpenCode did not confirm release of the previous thread-tools enrollment; check OpenCode is running with bigbud thread tools, then send again. Nothing was replayed."

  None of these texts may match the busy regex (`turnStart.ts:21-22`), so they never queue.

- **D10. Clean shutdown in the runtime, before the native client closes.** The new `Runtime.shutdown.ts` exports `retireV2ThreadToolsForShutdown(sessions, 5_000)`. `Runtime.close()` calls it first. It runs each session's `resources.onThreadToolsCleanup(signal)` concurrently under one `AbortSignal.timeout(5000)`; the hook gains an optional `signal` that is passed to `enrollment.detach(signal)`. Errors are logged and ignored, and leftover records are handled by Phase 1 recovery. `bridge.close()` keeps its revoke-only behavior as the last fence. Rejected: detaching in `bridge.close()`, which runs after `manager.close()` and has no native client.
- **D11. Failure class.** The contracts enum is `TurnStartFailureClass = busy|context-limit|session-dead|auth-or-quota|invalid-request|unsafe-to-replay|unknown`. It is an optional `failureClass` on the `thread.turn.start.failed` command, the `thread.turn-start-failed` payload and the failure activity payload; a missing value decodes as `unknown`. Typed errors are checked first: session-not-found, session-closed and process errors → `session-dead`; validation errors → `invalid-request` unless busy. Regex fallbacks are busy, context-limit, and auth/quota (`401|403|unauthori[sz]ed|quota|rate.?limit|insufficient (credit|balance)|billing`). V2 retirement and refusal errors ("no replay", "nothing was replayed", "retirement", "settlement unconfirmed") → `unsafe-to-replay`, meaning automatic action is unsafe and the user must act.
- **D12. Bounded recovery.** `withOneShotContextLimitRecovery` is generalized into `withTurnStartRecovery` (new `ProviderCommandReactorSessionOps.recovery.turnStart.ts`). `context-limit` behaves as today. `session-dead` gets (1) a revive: stop the binding and retry through the normal `ensureSession`, which resumes through `recoverSessionForThread`; then (2) if the result is still `session-dead|unknown`, a fresh session with `restartFreshIfInactive` and forced transcript rebuild. At most two extra attempts per turn-start, tracked by `(threadId, turn-start-requested eventId)` so recovery never loops. No recovery for `auth-or-quota|invalid-request|unsafe-to-replay|busy`. Each step appends `provider.session.recovery` activities (`reviving|fresh-replay|succeeded|failed`, tone info/warning/error).
- **D13. OpenCode V2 and fresh replay.** V2 revive goes through Phase 1. The fresh step is enabled for `opencodeV2` only if a test proves that `startSessionFresh` creates a new native session without touching the retired one (gate G2a). Otherwise V2 skips step (2) and goes to Phase 3.
- **D14. Attachments.** Remove both `hasAnyAttachments` early returns in `shouldRebuildProviderContextFromTranscript`. The transcript is text inside the 120 000-char budget and the attachments are still forwarded unchanged. The reason for the old skip is undocumented; the upstream squash `94b74f2662` gives none.
- **D15. UI threshold.** 5 s is a display threshold, not a timeout. If no turn has started 5 s after `thread.turn-start-requested`, the thread shows a blue "Reconnecting…" notice. It turns green "Reconnected" on turn start, amber when recovery is degraded, and red when the start fails. "Continue in a new thread" ships in Phase 3, because a correct, idempotent action needs the server fork. Phase 2 does not duplicate the client branch logic.
- **D16. Fork semantics.** New client command `thread.fork {commandId, sourceThreadId, threadId, reason: manual|session-dead|recovery-failed|provider-unavailable, failureEventId?, pendingMessageId?, modelSelection?, createdAt}`. The decider lives in the new `deciderThreads.fork.ts` and emits:
  - `thread.created` with `parentThread` = source and the new optional `forkOrigin {forkPointMessageId, reason, failureEventId?}`;
  - seeded `thread.message-sent` (the newest 200 completed, non-streaming messages up to the fork point, without the uncertain trailing turn, as in `buildResumedTurnInput`);
  - `thread.activity-appended` (newest 500, new ids, not `provider.turn.start.failed`/`provider.session.recovery`);
  - `thread.proposed-plan-upserted` (all, at most 50) and `thread.task-upserted` (at most 500, `projectorTasks.ts:18`);
  - on the source, an activity `thread.forked` naming the new thread.

  Turns, checkpoints and diffs are not copied, because they are tied to provider and git state. Automatic forks use the deterministic id `uuidv5-like(sha256(sourceThreadId+failureEventId))`, so a repeated failure or a restart maps to one fork. Manual retries reuse the client `threadId`. A second fork for the same `(source, failureEventId)` is a no-op.

- **D17. Pending message.** It is auto-submitted in the fork only when its failure class proves it was never admitted: `session-dead` from session start or a typed pre-dispatch error. Otherwise the fork opens with the message as a composer draft (web), and the user resends it. Source events are immutable, so the source keeps the message with a "Continued in …" activity.
- **D18. Auto-fork triggers.** Only after D12 is exhausted, or when recovery is impossible: `sessionRecovery: unsupported`, no resume state, or the thread's model is no longer offered. The fork keeps the provider. If the model is gone, it uses the provider default and the notice says so. It never forks automatically for `auth-or-quota`, `invalid-request` or `unsafe-to-replay`, or when the provider itself is disabled or unavailable; those cases offer only the manual action.
- **D19. Persistence.** Migration `128_ProjectionThreadsForkOrigin.ts` is additive: nullable `fork_point_message_id`, `fork_reason`, `fork_failure_event_id` on `projection_threads`. The source reuses `parent_thread_*`, so there are no new FK columns. Register it in `Migrations.ts` (import plus `migrationEntries`). Migration 127 and `OpencodeV2SharedBindings` stay as they are.

**Addendum, 15 October 2026 (Phase 1 implementation).** These notes amend the decisions above; the original text stays as written.

- **Q1 accepted.** A live retirement proof may carry the optional `deadBackendReceiptFence: {instance, digest}` with `receiptsSettled: false`. At settlement, every reserved receipt must be covered by the sealed reboot checkpoint or by this instance's fence; any other reserved receipt (reserved by the live instance) still blocks. Later reads re-verify the signed fence and reboot seal by digest and do not recompute coverage, because fenced receipts belong to dead processes. Proofs without a fence keep the original `proved()` rule, byte-identical. The logic lives in `Orchestration.receipts.fence.ts` and `Orchestration.enrollment.retirement.deadBackend.ts`. R1 is resolved by this.
- **Correction to Problem item 2 and D10.** Graceful shutdown already detaches. `Runtime.close()` → `teardown.drain()` → `stop()` → `releaseV2Session` → `releaseV2PreparedSession` → `onThreadToolsCleanup` detaches with the normal proof; a pre-change test passed without any code change. Records stay `active` only when a backend dies without finalizers (SIGKILL, crash, watcher hard kill), when the proof is unproved, or when the unbounded drain is killed. Task 1.7 therefore bounds this existing path rather than adding a new one. `V2RuntimeTeardown.beginShutdown()` creates one shared 5 s signal, and `releaseV2Session` → `releaseV2PreparedSession` → `onThreadToolsCleanup(signal)` resolves at the bound and swallows failure, leaving signed records for dead-backend recovery. `bridge.close()` is unchanged.
- **D6 implementation choices.**
  - Recovery does not rewrite the dead owner's enrollment to `revoked`. The retirement phase carries the truth, and rewriting would invalidate the revision `startExclusive` already read. Retries resume from `retiring` or `detach-acknowledged`.
  - Recovery is single-flight per retirement identity within the process.
  - The context exists only when `BackendInstance` is provided, the realpath of its `stateDir` equals the thread-tools state directory, and the per-instance fence exists. Attribution markers are written whenever the lock holder matches.
- **D4 detail.** `supersededRebootCheckpointDigest` is stored on the retirement record, not in the proof. `StateDirLockLive` moved to `startup/backendInstance.ts`, which provides `BackendInstance`, to avoid an import cycle.

## Definition of Done

All phases are merged and, on one SHA:

- `bun fmt`, `bun fmt:check`, `bun lint` (0 errors, no new warnings in touched files) and `bun typecheck` pass. Full root `bun run test` passes, or every failure is recorded as pre-existing with evidence.
- Every touched or new code file is 400 lines or fewer.
- Every acceptance criterion below has a named test.
- A ledger `docs/validation/dead-thread-recovery-<date>.md` records commands, exit codes and the user-run upgrade check (AC1.8).

## Phases

### Phase 1: OpenCode V2 dead-backend recovery and clean shutdown (Gate G1)

Independently shippable; no contracts or migrations.

#### 1.1 BackendInstance service

- Files: `apps/server/src/startup/stateDirLock.ts` (turn the layer into `Layer.effect`; move the service and `assertHeld` into the new `startup/backendInstance.ts` if the file would exceed 400 lines) and `apps/server/src/server.ts:363` (no shape change).
- Tests in `startup/backendInstance.test.ts`:
  - `assertHeld` passes for our own lock;
  - it fails when the lock is deleted, replaced with another nonce, or unreadable.

#### 1.2 Instance records

- Files: add `"instances"` to the `open`/`sibling` unions in `Orchestration.records.ts`; new `Orchestration.instances.ts` (owner marker read/write, `ensureReceiptFence(nonce)`); call `ensureReceiptFence` from `Application.orchestration.ts` before `new V2ThreadBridge`, passing `BackendInstance` from `Application.composition.ts` via `makeV2RequiredOrchestration`; write the marker in `Orchestration.enrollment.ts` `startExclusive` before the first `persist()`.
- Tests in `Orchestration.instances.test.ts`:
  - the marker is written before the enrollment record;
  - the fence lists only receipts reserved before open;
  - a second open with the same nonce reuses the fence;
  - a tampered fence signature is rejected.

#### 1.3 Proof kind

- Files: new `Orchestration.enrollment.retirement.deadBackend.ts` (`provedDeadBackend`, fence verification); `Orchestration.enrollment.retirement.ts` (`settle`/`assertSettled` accept the union; `supersedeStalledReboot`).
- Tests in `Orchestration.enrollment.retirement.deadBackend.test.ts`:
  - exact keys and kind;
  - extra or missing keys are rejected;
  - a live `proved()` vector is unchanged;
  - a dead proof with a wrong fence digest is rejected;
  - a valid reboot proof still wins over supersession.

#### 1.4 Recovery flow

- Files: new `Orchestration.enrollment.deadBackend.ts` (D3, D6–D9); `Orchestration.enrollment.recovery.ts` (both functions delegate); `Runtime.types.ts` and `Runtime.sessions.ts:148` (scope gets `client`, `transport`); `Application.orchestration.lazy.ts:52-57`.
- Tests in `Orchestration.enrollment.deadBackend.test.ts`, each also asserting that native calls are bounded:
  - success with a legacy owner without a marker;
  - success with a foreign marker whose pid is dead (a real exited child pid);
  - refusal when the native session is active (message text checked, no record changed);
  - refusal when the marker pid is alive;
  - refusal when the lock is not held or `BackendInstance` is absent;
  - refusal on a native RPC error;
  - registry-absent and expired-lease evidence accepted;
  - two concurrent sends on one thread give one settlement.

#### 1.5 Reboot supersession

- Test in `Orchestration.enrollment.deadBackend.reboot.test.ts`: a `reboot-prepared` retirement whose seal is missing or mismatched is superseded and settles. A valid seal makes the path a no-op, and checkpoint and seal bytes are unchanged.

#### 1.6 Real restart test

- Files: `Orchestration.enrollment.restart.test.ts` plus `Orchestration.enrollment.restart.process.fixture.ts`.
- Backend A is a child `bun` process. It acquires the real lock in a temp `BIGBUD_HOME` under `$TMPDIR`, persists the enrollment, owner marker and one `reserved` receipt with the same signer (key material on stdin, as in `foreign.process.fixture.ts`), and reports ready. The native lease is enrolled through the in-test plugin fixture, which stands in for the long-lived OpenCode daemon. A is then `SIGKILL`ed.
- Instance B acquires the lock (takeover proves A dead), opens the orchestration (fence includes A's receipt) and sends through `withV2ProductionThreadTools` on the same thread. The send succeeds, the enrollment becomes `replacement-bound`, and `receipts.find` on A's receipt still throws.
- Repeat with the native session reported active: refusal.

#### 1.7 Clean shutdown

- Files: new `Runtime.shutdown.ts`; `Runtime.ts` `close()` (one call); `Orchestration.bridge.ts:206` (cleanup accepts `signal`); `Runtime.types.ts:81`.
- Tests in `Runtime.shutdown.test.ts`:
  - an idle attached session is settled (`settled` retirement) after `runtime.close()`;
  - a hung native detach is abandoned at 5 s and leaves records for 1.4;
  - a busy session leaves `detach-acknowledged`, which 1.6-style recovery then settles.

#### 1.8 User upgrade check (manual, user-run)

- After merge, the user restarts their backend. Then: send on each of the four stuck threads; check the ledger with a read-only script that summarizes phases and never prints `callbackToken`.
- Expected: the `enrollment.v2` threads show `proof.kind` dead-backend, and the v1 threads are either reboot-settled or superseded.

Commands:

- `bun run --cwd apps/server vitest run src/startup src/provider/Layers/OpencodeV2/Orchestration.enrollment src/provider/Layers/OpencodeV2/Orchestration.instances.test.ts src/provider/Layers/OpencodeV2/Runtime.shutdown.test.ts src/provider/Layers/OpencodeV2/RebootRecovery src/provider/Layers/OpencodeV2/Orchestration.production`
- then `bun fmt`, `bun lint`, `bun typecheck`.

**Exit (G1):** all 1.x tests are green, the unchanged-tests list in Current State is green, and no file is over 400 lines.

### Phase 2: Typed classification, bounded in-place recovery, attachment replay fix (Gate G2)

Depends on G1 only for the V2 classification texts.

#### 2.1 Contracts

- Files: new `packages/contracts/src/orchestration/orchestration.turnFailure.ts` (enum); optional `failureClass` in `orchestration.events.thread.ts:187-192` and `orchestration.commands.internal.ts:106-113`.
- Tests: `bun run --cwd packages/contracts test`, with old payloads (no `failureClass`) still decoding.

#### 2.2 Classifier

- Files: new `apps/server/src/orchestration/Layers/ProviderTurnFailureClassification.ts` (D11, reusing `isProviderTurnBusyCause` and `isProviderContextLimitError`); `ProviderCommandReactorHandlers.failures.ts` and `.turnStart.ts` pass the class through.
- Tests in `ProviderTurnFailureClassification.test.ts`: one row per class, typed before regex, and the V2 texts from D9 classified as `unsafe-to-replay` and never busy.

#### 2.3 Recovery

- Files: new `ProviderCommandReactorSessionOps.recovery.turnStart.ts`; `ProviderCommandReactorSessionOps.ts:243-248` uses it; `.recovery.ts` keeps its context-limit helpers.
- Tests in `ProviderCommandReactor.sessionRecovery.test.ts`, using `ProviderCommandReactor.test.helpers.ts`:
  - revive succeeds;
  - revive fails, then fresh replay succeeds and the transcript excludes the uncertain turn;
  - both fail, giving one `turn-start-failed` with class `session-dead`, exactly three attempts and no loop on redelivery;
  - `auth-or-quota` is never retried;
  - context-limit behavior is unchanged (existing `ProviderCommandReactorSessionOps.recovery.test.ts`).

#### 2.4 Gate G2a

- Test `ProviderCommandReactorSessionOps.opencodeV2.fresh.test.ts` decides D13 and records the outcome in this plan.

#### 2.5 Attachments

- Files: `ProviderCommandReactorSessionOps.context.ts`.
- Tests: update `.context.test.ts`; add a send test where attachments are forwarded and the transcript is included.

#### 2.6 Web notice

- Files: new `apps/web/src/components/chat/view/ThreadRecoveryNotice.tsx` plus `.logic.ts` (pure timer and state machine, fed by the session and latest-turn state in `events.store.threads.runtime.ts`), rendered in `apps/web/src/components/chat/view/chat-view/ChatViewChatBody.tsx`.
- Tests:
  - `ThreadRecoveryNotice.logic.test.ts`: the 5 s threshold, the state transitions and the color mapping;
  - browser test `ThreadRecoveryNotice.browser.tsx`: visibility, `role="status"` and `aria-live="polite"`.

Commands:

- `bun run --cwd packages/contracts test`
- `bun run --cwd apps/server vitest run src/orchestration/Layers`
- `bun run --cwd apps/web vitest run src/components/chat/view/ThreadRecoveryNotice.logic.test.ts`
- `bun run --cwd apps/web test:browser src/components/chat/view/ThreadRecoveryNotice.browser.tsx`
- then `bun fmt`, `bun lint`, `bun typecheck`.

**Exit (G2):** the above is green and G2a is decided and recorded.

### Phase 3: Server-side fork fallback (Gate G3)

Depends on G2 (failure classes and the recovery-exhausted signal).

#### 3.1 Contracts

- `thread.fork` client command, optional `forkOrigin` on `ThreadCreatedPayload`, and the `thread.forked` activity kind.
- Tests: the contracts tests, and old `thread.created` payloads still decode.

#### 3.2 Decider and projector

- Files: new `apps/server/src/orchestration/deciderThreads.fork.ts`; registration in `deciderThreads.ts`; projector fields (`projector.ts`, `persistence/Layers/ProjectionThreads.ts`); migration 128 plus `Migrations.ts`.
- Tests:
  - `deciderThreads.fork.test.ts`: caps, exclusions, idempotency, fork point;
  - `projector.fork.test.ts`;
  - `128_ProjectionThreadsForkOrigin.test.ts`: additive, existing rows null.
- Update the FK ownership matrix doc. Add a purge test proving that deleting the source keeps the fork's attachments.

#### 3.3 Automatic fork

- Files: new `ProviderCommandReactorHandlers.fork.ts`, invoked from the recovery-exhausted and recovery-impossible branches (D18), plus the D17 pending-message handling.
- Tests in `ProviderCommandReactor.fork.test.ts`:
  - an auto fork happens once per failure, also across a restart (deterministic id);
  - no fork for auth, invalid or unsafe failures;
  - the pending message is auto-sent only when it was never admitted.

#### 3.4 Web

- Files: the "Continue in a new thread" action in `ThreadRecoveryNotice`; the notice naming the source in the forked thread (uses `parentThread` plus `forkOrigin`); navigation to the new thread (`useThreadActions.ts`); a composer draft for D17.
- Tests: logic tests plus a browser test (action visible after 5 s, navigation, source notice).

Commands:

- the Phase 2 commands plus `bun run --cwd apps/server vitest run src/orchestration src/persistence/Migrations src/deletion`
- then `bun fmt`, `bun lint`, `bun typecheck`, and full root `bun run test`.

**Exit (G3):** green, plus the DoD ledger.

## Risks And Decision Gates

- **R1. Unfenced dead-backend receipts still block live settlement (pre-existing, item 4).** After Phase 1 such threads recover at the next restart, but in-process detach and bootstrap replacement (`Orchestration.bridge.ts:242-245`) stay blocked while that receipt exists. Accepting the per-instance fence in the _live_ proof would fix this, but it changes live proof rules, so it needs explicit approval (open question Q1). Default: unchanged. _Resolved 2026-10-15: Q1 accepted and implemented; see the Decisions addendum._
- **R2. Point-in-time native inactivity.** Between `session.active()` and settlement, only someone driving the bigbud-owned native session directly in the OpenCode TUI could start a turn. The window matches the existing `nativeDrained` checks (`bridge.activation.ts:25-36`). Accepted and documented.
- **R3. Legacy owners without a marker plus a manually deleted lock.** A still-running old backend could have its live enrollment detached. Its native turn is protected by R2's check, and its later callbacks fail closed. This is accepted only for pre-upgrade records. New records always carry a marker (D3b).
- **R4. Legacy v1 inspect/detach.** If the installed plugin no longer answers `bigbud.thread.v1` cleanup, those threads keep failing with the D9 "native unconfirmed" text. Evidence for the user's two v1 threads suggests the reboot seal settles them first (Problem 3). Verify in AC1.8.
- **R5. Shutdown deadline.** 5 s per shutdown, run concurrently. If the dev watcher's kill happens sooner, Phase 1 recovery covers it.
- **Gate G2a** decides D13. **Q1** decides R1.
- **Rollback.**
  - Phase 1: revert the code. `instances/` records are ignored by old builds; retirements carrying a dead-backend proof fail closed on old builds (the thread is blocked again, never unsafe); enrollment and receipt formats are unchanged.
  - Phase 2: the `failureClass` field is optional and old clients ignore it.
  - Phase 3: migration 128 is additive and is never dropped. Reverting the code leaves null columns. Never remove migration 127 or `OpencodeV2SharedBindings`; new migrations stay additive.

## Testing And Validation

The tests are listed per task above, by layer:

- contracts: decode compatibility;
- unit: proof validators, classifier, recovery state machine, notice logic;
- provider adapter: the V2 dead-backend flow against the plugin fixture;
- server integration: real-process restart (1.6), production fixture send, reactor recovery and fork with SQLite;
- browser: notice and fork action;
- manual: AC1.8.

Use `bun run test` / `bun run --cwd <pkg> vitest run <files>`, never `bun test`. Server tests stay sequential. No test starts a server against `~/.bigbud`; temp homes go under `$TMPDIR`.

## Acceptance Criteria

- AC1.1 A thread enrolled by a killed backend sends successfully after restart when its native session is idle (1.6); A's reserved receipt is never replayed.
- AC1.2 The same scenario with the native session active is refused with the D9 text and no record changes (1.4, 1.6).
- AC1.3 A live other lock holder, an unreadable or replaced lock, a live marker pid or an absent `BackendInstance` is refused, and today's message is unchanged when the service is absent (1.4); `foreign.process.test.ts` still passes.
- AC1.4 A failed `reboot-prepared` retirement is superseded and settles; a valid seal still settles through the reboot path (1.5).
- AC1.5 `runtime.close()` settles idle owners within 5 s and leaves recoverable records otherwise (1.7).
- AC1.6 The live `proved()` behavior is unchanged (existing retirement tests plus 1.3).
- AC1.7 Two concurrent sends recover exactly once (1.4).
- AC1.8 User check: all four stuck threads accept a send after upgrade (ledger).
- AC2.1 Every `thread.turn-start-failed` carries `failureClass`; old events decode (2.1, 2.2).
- AC2.2 `session-dead` gets at most one revive and one fresh replay and never loops; auth, invalid, unsafe and busy failures are never auto-recovered (2.3).
- AC2.3 Transcript replay happens with attachments, and the attachments are forwarded (2.5).
- AC2.4 "Reconnecting…" appears after 5 s in blue and resolves green, amber or red (2.6).
- AC3.1 `thread.fork` copies capped messages, activities, plans and tasks, records `parentThread` and `forkOrigin`, and is idempotent per `(source, failureEventId)` (3.2).
- AC3.2 Automatic fork happens only under D18, and the pending message is auto-sent only under D17 (3.3).
- AC3.3 The manual action navigates to the fork, and the fork names its source (3.4).
- AC3.4 Deleting the source keeps the fork's attachments (3.2).

## Open Questions

- Q1. Resolved 2026-10-15: yes. The live retirement proof accepts reserved receipts covered by a dead-backend fence (D5) or the reboot fence, because their handlers ran in a provably dead process and cannot be in flight. Reserved receipts not covered by a fence (reserved by the current instance) still block live settlement exactly as before. Without this, one orphaned receipt blocks live settlement and bootstrap replacement for every thread.
- Q2. Resolved 2026-10-15: no Kanban card; the plan and its ledger track the work.
