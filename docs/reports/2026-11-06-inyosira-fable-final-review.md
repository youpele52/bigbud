# Inyosira native organiser — final Fable review (round 2)

**Date:** 6 November, 2026
**Reviewer:** delegated Fable thread. Read-only source review. No source edits, no staging, no commits, no broad checks, no live userdata.
**Inputs:** `docs/reports/2026-11-06-inyosira-opus-fixes.md` (section "Round 2 — re-review R1–R9 remediation"), `docs/reports/2026-11-06-inyosira-fable-rereview.md` (R1–R9 and addendum), and the current source of every file in the round 2 manifest. Line numbers are from the checkout at review time.
**Test evidence:** quoted from the integration owner and Opus logs, except the Rust organiser unit run, which I ran myself earlier in this round (`cargo test --locked -p bigbud-desktop-supervisor organization`, 45 passed). The confirmation rerun of the four files touched after the batches is green (`/tmp/inyosira-r-final-confirm.log`: 4 files, 6 tests passed).

## Verdict

**Code acceptance: accepted.** R1 to R9 are implemented in source as the re-review asked. No regression was found in the authority split, fencing, ledger, serialized final recheck, lifecycle budget or notifications. No blocker remains for code acceptance or cutover.

Two low follow-ups and three notes are listed below. None blocks cutover.

External qualification remains separate from code acceptance and is not claimed: packaged Windows, macOS and Linux runs, Windows ARM64, release workflow execution, standalone packaging end to end, real two-socket engagement, and a measured run against the user's large real userdata.

## Verification per finding

| ID  | Verified in source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Status |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| R1  | `session_operations.rs:37-40, 94-96` mixes a per-session attempt-0 counter into the occurrence digest. Retransmissions reuse the stored proposal (`:190-205`). Not-due retries keep the occurrence and advance the attempt (`:219-225`). Rust test `session_tests.rs:338-363` covers two stale receipts with no facts between them. TS test `organizationBridge.proposals.ledger.engine.test.ts` runs the real engine and ledger: a reused identity with a new creation time is still refused (fail-closed kept), and a fresh attempt-0 identity is prepared and settles `stale` with a receipt. The ledger's `UNIQUE (occurrence_id, attempt)` (migration 149) keeps the occurrence lookup indexed.                                                | Fixed  |
| R2  | `organizationBridge.capture.ts:35-46`: a failed capture stream is a resync only when `isOverflowed` is true; any other cause stays a real fault; a normal end is a resync. The delivery hub sets the overflow flag before it fails the stream (`OrchestrationEngine.deliveryHub.ts:67-69`), so the check is not racy. `organizationBridge.capture.test.ts` overflows a real hub capture through the lifecycle (four attempts in 15 s, never paused) and keeps a non-overflow die as a real fault.                                                                                                                                                                                                                                                   | Fixed  |
| R3  | `organizationSnapshot.capture.ts:18-29`: budget is the larger of 120 s and 10 ms per member, doubled per consecutive overrun, capped at 30 min. A `COUNT` precheck with the same predicate as the sweep (`organizationFacts.query.ts:91-103`) refuses more than 100 000 members before any heavy read. Overrun at the cap and the in-capture row limit raise `OrganizationLimit`. `organizationLifecycle.ts:79-88` publishes paused with a reason and waits only on `explicitRetry`, with no cooldown loop. The reactor builds a fresh settings subscription per wait (`ThreadOrganizationReactor.ts:38`), so it cannot spin. The reason travels through `organizationStatus.ts`, the contract (`organizationAutomation.ts:12`) and the status RPC. | Fixed  |
| R4  | `organizationBridge.loops.ts:49-75`: a clock gap requests one resync and the heartbeat keeps beating. `observedAtMs` stays frozen, so acceptance's 75 s freshness and forward-time checks (`organizationAcceptance.ts:81-83`) refuse any proposal against the old samples. The deferred resync then fences after the in-flight proposal settles (`organizationBridge.failure.ts`).                                                                                                                                                                                                                                                                                                                                                                  | Fixed  |
| R5  | `organizationBridge.loops.ts:112-124`: a completed sweep re-marks every published row it did not see. A real deletion then publishes its tombstone, and a row that vanished without one resyncs (`organizationBridge.publisher.ts:65-78`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Fixed  |
| R6  | `organizationBridge.proposals.ts:27-49`: one dispatch helper, used by the handler and startup recovery (`organizationBridge.startup.ts:55`), settles a persisted rejection (`OrchestrationCommandPreviouslyRejectedError`, raised at `OrchestrationEngine.commandProcessing.ts:119`) as `stale`. Recovery can no longer latch on one row.                                                                                                                                                                                                                                                                                                                                                                                                           | Fixed  |
| R7  | `organizationObservation.ts`: tool activity refreshes a thread at most once per second; everything else stays immediate. The urgent pattern covers every attention source the facts read: `approval.*`, `user-input.*` and `delegation.model-choice-*` (`ProjectionThreads.quiescence.ts:25-29`, `DelegatedModelChoiceSql.ts`). A throttled mark is delayed, never dropped; cooling entries count toward capacity and overflow still requests a rescan.                                                                                                                                                                                                                                                                                             | Fixed  |
| R8  | `ORGANIZATION_PROPOSAL_UNSETTLED_MS = 20_000` (`organizationBridge.proposals.ts:21`) fires before Rust's acknowledgement budget of about 22.2 s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Fixed  |
| R9  | `organizationBridge.policy.ts:46-76`: each tick compares the in-memory fingerprint; the stored barrier is read on a deliberate-organisation hint or the 30 s fallback, and never during an in-flight proposal. Acceptance still reads the stored barrier, so a missed hint is fail-closed. Shared paused copy in `apps/web/src/lib/organizationStatusCopy.ts` is used by the sidebar and Settings.                                                                                                                                                                                                                                                                                                                                                  | Fixed  |

## Regression checks

- The capture consumer is still forked before policy reconcile, recovery and snapshot (`organizationBridge.ts:91-112`), so changes during capture are marked.
- Only native-fault paths consume the three-in-30 s budget. Resyncs are spaced, limits wait on settings, and a proposal outlasting 20 s is a real fault by design.
- The ledger capacity counts only `prepared` rows (`ThreadOrganizationOperations.ts:118-121`). The extra settled `stale` rows from R1 therefore cannot trip `capacity`.
- The crash fixture was adapted to the new API with unchanged behaviour. The integration owner's 52-file organiser run (171 tests) finished before three late edits. Those edits were formatting-only in two test files plus the optional `markBarrier` call. The confirmation rerun of the four affected files passed.
- All changed code files are 400 lines or fewer (largest `session_tests.rs`, 371).

## Remaining follow-ups (not blockers)

- **F1. Ledger retention (low).** `thread_organization_operations` has no pruning, and no code deletes settled rows. Every automatic attempt leaves one settled row, and after R1 each stale re-proposal adds another. Stale backoff caps at 60 s, so a thread stuck on a row-independent stale adds at most about 1 400 rows a day. Ordinary use adds one row per automatic move. Fix: prune settled rows older than a retention window, keeping each thread's latest settled row and any row an Undo or a pending retransmission can still reference. Add a test that pruning never removes the row a duplicate retransmission needs.
- **F2. Copy duplicates the limit (low).** The thread-limit copy hardcodes "100,000" (`organizationStatusCopy.ts:12`) instead of deriving it from the server limit. If the limit changes, the copy goes stale. Fix: add the limit to the status payload, or keep the number in a shared constant with a test that pins both.
- **N1.** A barrier hint raised before the policy follower exists (between policy reconcile and activation) waits for the 30 s fallback. Acceptance reads the stored barrier, so proposals are refused, not misapplied. Documented in `organizationBridge.ts:87-89`.
- **N2.** `capture-time` needs five consecutive overruns on a small database (120 s doubling to 30 min). A laptop that sleeps during every capture could reach it. Recovery is a settings change or a restart, and manual moves keep working. This is bounded and intended.
- **N3.** The limit copy says "change any Inyosira setting". The code retries on any settings save. The copy is narrower than the behaviour, which is safe.

## Qualification status

| Item                                                                                      | Status                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Cross-process lost-ACK kill and restart                                                   | Closed as bounded qualification (`organizationRecovery.process.test.ts`, re-run after the fixture adaptation)                              |
| Synthetic 5 k and 10 k database                                                           | Closed for ordinary databases (`organizationSnapshot.scale.test.ts`)                                                                       |
| User's large real userdata                                                                | Not measured. R3 now guarantees a bounded outcome there: activation, or a terminal limit with an explanation, never an endless heavy loop. |
| No dedicated Retry control                                                                | Not a blocker. Settings change, deliberate move, cooldown and restart recover paused; a settings change recovers a limit                   |
| Fallback-fenced notifications silent                                                      | Not a blocker. Note it as a degraded-mode limitation                                                                                       |
| Packaged OS, Windows ARM64, release workflow, standalone packaging, two-socket engagement | External qualification. Required before a release or production claim, not for code acceptance                                             |

## Fix plan

1. Cutover may proceed on code. No source change is required for acceptance.
2. After cutover: F1 ledger retention with its test, then F2.
3. Before any release or production claim: run the external qualification matrix above, and one observed activation on a copy of the large userdata.

## Addendum — F1 and F2 fixed

The user asked for both follow-ups to be fixed. The Opus thread had finished and the parent was running packaged qualification, so there was no concurrent source writer. Nothing was staged or committed.

**F1, ledger retention.**

- `ThreadOrganizationOperations.ts` gains `prune(nowMs)` and `ORGANIZATION_OPERATION_RETENTION` (7 days, 500-row batches). Each batch is its own short transaction under the runtime lock, so canonical commands interleave.
- Prepared rows are never pruned. A not-due row ages from its retry deadline, so a waiting retry chain keeps its anchor. A row that is any thread's `latest_automatic_move_id` is kept at any age, because Undo reads it. Identical retransmissions only occur within seconds, far inside the window.
- `makeOrganizationLedgerPruner` in `organizationBridge.loops.ts` runs retention at most hourly across bridge attempts and only after native activation. A failure is logged and retried at the next interval. It never reaches the failure gate, so housekeeping cannot pause automation.
- Tests: `ThreadOrganizationOperations.retention.test.ts` covers each rule with a pair of rows that differ only in that rule, checks that the kept not-due row still accepts its next attempt, and drains a backlog larger than two batches. `organizationBridge.loops.pruner.test.ts` covers hourly pacing and failure isolation.

**F2, shared thread limit.**

- `ORGANIZATION_THREAD_LIMIT` now lives in `packages/contracts/src/constants/organization.constant.ts`. The server's `ORGANIZATION_LIMITS.liveRows` and the web paused copy both read it, and the copy test asserts the formatted constant.
- The Rust admission check still pins 100 000 independently (`admission_validation.rs:13`). A mismatch would fail at hello, which the existing bridge engine tests exercise.

**Checks (focused, all green).**

| Check                                                                       | Result                                      |
| --------------------------------------------------------------------------- | ------------------------------------------- |
| Line limit, 9 changed files                                                 | Largest 270 lines (`organizationBridge.ts`) |
| oxfmt and oxlint, explicit list                                             | Clean, 0 warnings                           |
| Server, contracts and web typechecks                                        | Exit 0, no type errors                      |
| Ledger and loop tests (5 files)                                             | 13 passed                                   |
| Bridge engine, load, startup, capture and real-binary crash tests (5 files) | 13 passed, none skipped                     |
| Web copy test                                                               | 2 passed                                    |

The verdict above is unchanged. With F1 and F2 fixed, the remaining limits are the notes N1 to N3 and the external qualification list.
