# Inyosira native organiser — independent Fable 5.1 re-review

**Date:** 6 November, 2026
**Reviewer:** delegated Fable 5.1 thread (read-only source review; no source edits, no staging, no commits, no checks run, no live userdata)
**Inputs:** `docs/reports/2026-11-06-inyosira-opus-fixes.md`, `docs/reports/2026-11-06-inyosira-fable-review.md` (findings and addendum), `AGENTS.md`, `crates/AGENTS.md`, the approved plan and product agreements, and the current dirty checkout of `dev`.
**Method:** every claim in the Opus remediation report was checked against the source it names. Line numbers below are from the checkout at review time. Test results quoted anywhere are the integration owner's; I ran nothing.

## Verdict

**The remediation is real and matches the agreements.** C1, C2, H1, H2, H4, M1, M2, M3, M4, M5, M6, M7, M8, M9, L1, L2, the lifecycle addendum and D1 are implemented in source as described, and the acceptance authority split, fencing, ledger and serialized final recheck are unchanged. H3 is implemented except for one path (capture overflow, finding R2).

**Four independent findings remain, none of which reintroduces a TS scheduler or weakens acceptance.** Two should be fixed before cutover because they turn routine conditions into native-fault restarts or an unbounded sync loop; two are robustness gaps with bounded impact:

| ID  | Severity | Summary                                                                                                                                                                                               |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Medium   | Rust re-proposes a stale movement with the **same occurrence and operation identity** once the backoff lifts; the TS ledger refuses it as `conflict`, which the bridge treats as a real fault         |
| R2  | Medium   | Live-capture overflow fails the bridge through the capture stream's `die`, not through the `OrganizationResync` path, so it consumes the paused budget                                                |
| R3  | Medium   | The snapshot capture budget is a fixed 120 s regardless of table size; a database whose read-only pass exceeds it never activates and loops with heavy DB load                                        |
| R4  | Low–Med  | A routine resync raised by the heartbeat fiber while a proposal is in flight is deferred, but the heartbeat fiber is already dead; a slow proposal then becomes a Rust owner timeout and a real fault |

Lower findings (R5–R9) and the classification of the five known unfinished qualification items follow.

**Addendum (end of this report):** the cross-process crash test and the 5 k/10 k scale test added after this re-review were verified against source. They close two of the five known items as bounded qualification and narrow R3. The verdict and the four findings above are unchanged, and the final acceptance decision is stated in the addendum.

## Verification of each prior finding

| ID  | Verified in source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Status |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| C1  | `organizationFacts.store.ts:35-47` reads the orchestration frontier and `canonical_frontier` inside the same write transaction (`UPDATE … singleton = singleton` takes the lock first) and returns `max` of both; `stale` is now only a raw-row race. `organizationBridge.publisher.ts:53-58` re-marks on `stale` and keeps `state.frontier` monotonic. Tests: `organizationFacts.store.test.ts:89`, `organizationBridge.publisher.test.ts:53`.                                                                                                                                        | Fixed  |
| C2  | `organizationObservation.ts:4-32` coalesces into a bounded set (2000), drops assistant `thread.message-sent`, requests a rescan on overflow. `organizationBridge.ts:89-100` only marks. Proposals use a separate `Queue.dropping(32)` (`:140`). Residual load noted in R7.                                                                                                                                                                                                                                                                                                             | Fixed  |
| H1  | Heartbeat is its own 1 s fiber that never touches the DB (`organizationBridge.loops.ts:36-70`, forked at `organizationBridge.ts:194-197`). Membership sweep is an indexed ID page of 32 every 15 s; refresh work is capped at 32 rows or 200 ms per 200 ms pass (`loops.ts:77-116`). Per-thread raw reads scope the model-choice CTE (`organizationFacts.query.ts:42`). Test `organizationBridge.loops.test.ts:106-181`.                                                                                                                                                               | Fixed  |
| H2  | `organizationSnapshot.capture.ts:36-57`: per-row `observe`, each its own short write transaction, 3 stale retries, 120 s wall budget as `OrganizationResync`, lagging projection refused before sampling owners (`:30-32`). The live capture is opened before the capture (`organizationBridge.ts:76-100`). Budget sizing is R3.                                                                                                                                                                                                                                                       | Fixed  |
| H3  | Clock discontinuity → `OrganizationResync` (`loops.ts:49-52`); disappearance without tombstone → resync (`publisher.ts:71-76`); concurrent policy reconcile → resync (`organizationBridge.startup.ts:38-39`); paused recovers on settings change, deliberate move or 5 min cooldown (`ThreadOrganizationReactor.ts:33-36`, `organizationRecovery.ts`, `organizationFacts.events.ts:103`, `organizationLifecycle.ts:47-56`). Capture overflow is still a real fault in practice: R2.                                                                                                    | Mostly |
| H4  | `organizationBridge.ts:141-158` admits and enqueues only; outcomes travel in receipts. Serial handler with a 30 s unsettled bound (`organizationBridge.proposals.ts:19, 70-75`). Retransmissions resolve as ledger duplicates (`ThreadOrganizationOperations.ts:84-88`). Test `organizationBridge.proposals.test.ts:70-107`. Note R8.                                                                                                                                                                                                                                                  | Fixed  |
| M1  | `policy` frame (`organizationProtocol.ts:118-119`, `v1.proto:24`, `admission_wire.rs` Frame 10). Follower commits/reads the DB first, switches `owner.policy`, then sends; never during an in-flight proposal (`organizationBridge.policy.ts:39-64`). Rust `admission_policy.rs:9-21, 37-55` (higher version or same version with barrier advancing only), `scheduler.rs:98-126` (barrier reset per rule), `session.rs:109-117`. Acceptance reads the drain barrier from the DB (`organizationAcceptance.ts:65-79`), so the window between the DB commit and the frame is fail-closed. | Fixed  |
| M2  | `session_operations.rs:17-29, 42-50, 148-169`: blocked on the thread's own `fact_version`; stale lifts after 1 s doubling to 60 s; unrelated facts never lift it. Test `session_tests.rs:243-271`. Identity consequence in R1.                                                                                                                                                                                                                                                                                                                                                         | Fixed  |
| M3  | TS pre-ready budget 60 s total / 10 s progress (`loops.ts:17-18, 55-59`) matches `session.rs:152-157`. Rust also requires `hello` within 5 s of process start (`session.rs:149-151`); TS sends it immediately after spawn (`organizationBridge.ts:193-202`).                                                                                                                                                                                                                                                                                                                           | Fixed  |
| M4  | Armed only on `live` at the applied sequence (`-__root.logic.tsx:272-276`), admission by `sequence > frontier` (`organizationNotifications.ts:15-26`), age cap on newest observed server `occurredAt` only (`:29-37`, `organizationNotifications.delivery.ts:80-92`), disarmed on any other lifecycle state.                                                                                                                                                                                                                                                                           | Fixed  |
| M5  | Event path toasts only events with `automaticMove` (`organizationNotifications.ts:23`); manual confirmation comes from the issuing client's own accepted commands for threads whose state actually changed (`Sidebar.inyosira.actions.ts:52-67`). Undo restorations carry no `automaticMove`, so they do not re-toast.                                                                                                                                                                                                                                                                 | Fixed  |
| M6  | Legacy schedulers deleted from production paths and recreated as `*.fixture.ts` (git status `D`/`??`); `idleRulesFor` in `orchestration/threadOrganization.idleRules.ts`; static guard `organizationScheduler.static.test.ts`. No production import of the fixtures (grep).                                                                                                                                                                                                                                                                                                            | Fixed  |
| M7  | `recordTransition` no longer exists anywhere in `apps/server/src` (grep). The hook (`organizationFacts.events.ts`) and the store (`organizationFacts.store.ts`) are the two writers, each owning disjoint columns (store never touches `manual_until_ms`, `latest_automatic_move_id`, `deliberate_organization_at_ms`, `needs_attention_reminder` on conflict).                                                                                                                                                                                                                        | Fixed  |
| M8  | Banner only when `enabled == null && !dismissed` on an existing install (`Sidebar.inyosiraStatus.tsx:36`); Enable writes only `inyosiraPresentTargetEnabled` and the dismissal (`:16-20`); the Settings switch writes both (`InyosiraIdleSettingsSection.tsx:110-114`).                                                                                                                                                                                                                                                                                                                | Fixed  |
| M9  | `DECISION_SPACING_MS = 250` for fact-dirtied passes; the deadline reschedule (≤15 s) and the earliest stale-backoff expiry still wake it (`session.rs:31-32, 175-228`). Test `session_tests.rs:273-299`.                                                                                                                                                                                                                                                                                                                                                                               | Fixed  |
| L1  | Half-cleared snooze pair → open-ended protected snooze, `inconsistent-snooze` identity if none (`organizationFacts.build.ts:63-71`). Not logged, as the report states.                                                                                                                                                                                                                                                                                                                                                                                                                 | Fixed  |
| L2  | One shared poll store (`useOrganizationStatus.ts:9-60`); engagement RPC marks the thread through `owner.observe` (`wsRpcHandlers.organizationAutomation.ts:42-43`, `organizationBridge.ts:129`).                                                                                                                                                                                                                                                                                                                                                                                       | Fixed  |

### Lifecycle addendum

- `organizationLifecycle.ts:17-26, 57-73`: resyncs spaced 2 s doubling to 60 s, reset after a 60 s healthy run, never counted; three real failures in 30 s latch paused; paused waits on `raceFirst(5 min cooldown, retry)`; `retry` is a fresh subscription per pause to the settings stream and the recovery signal (`ThreadOrganizationReactor.ts:33-36`). Verified.
- `OrganizationFailureGate` (`organizationBridge.failure.ts`) defers a resync raised during an in-flight proposal until `proposalSettled` and fences real faults immediately. Verified, with the consequence in R4.
- Changes during capture coalesce: the live capture is open before the capture starts and observation re-reads current state. Verified.

### D1

- Proto/wire: `facts.proto:30` (`automatic_placement = 17`), `scheduling.proto:16` (`REASON_RESOLVED = 7`), `admission_wire.rs` row schema `(Row, 2..=10 | 12..=17)`. Verified.
- TS facts: `organizationFacts.query.ts:67` selects `latest_automatic_move_id`; `organizationFacts.build.ts:90` sets `automaticPlacement` only for Needs you rows and it is in the digest (`:92-94`). Verified.
- Rust reaction order (`scheduler.rs:194-228`): new attention interrupts manual/snooze → manual wins → snooze expiry → actionable → **automatic Needs you returns to Present whatever the work state** → active returns to Present. Matches the addendum's rules 1–3.
- TS validation (`organizationProposal.validation.ts:116-133`): a live manual override returns `not-due` first; `resolved` requires from Needs you, destination Present, not actionable, not snoozed, `automaticPlacement === true`, no cutoff. Acceptance maps it to `reason: "move", source: "automatic"` with `automaticMove.reason: "resolved"` (`organizationAcceptance.ts:116-140`); the hook grants grace on it (`organizationFacts.events.ts:75-80`). Verified.
- Hook identity rule (`organizationFacts.events.ts:81-100`): `latest_automatic_move_id` changes only on organisation updates (automatic id, or `NULL` for deliberate/snooze/archive updates) and on human messages; approval/input responses and request activity keep it. This is the fix that makes D1 reachable; the engine test `organizationAcceptance.resolved.engine.test.ts` exercises requested → Needs you → answered while idle → Present with grace → Undo → restored placement never auto-returns. Verified.
- Behavioural note (not a defect): a human message on an automatic Needs you placement clears the identity (`:84`). If that message starts work the `active` reaction returns the thread to Present; if the turn fails to start, the thread stays in Needs you as a manual placement. That is a defensible reading of "a human message is new work" and I record it rather than ask for a change.
- Older-rule scope stays Present/Later (`scheduler.rs:153-157`, `validation.ts:90`), per the user's instruction.

### Regression checks

- `thread.organization.react` is not in the client command schema (grep of `orchestration.commands.client.ts`); the envelope option is server-internal (`OrchestrationEngine.ts:288-290`).
- Acceptance and Undo still run inside the serialized command transaction, settle the ledger in the same transaction and run the runtime hook after projections (`OrchestrationEngine.commandProcessing.ts:184-216`).
- Only `OrchestrationCommandInvariantError` persists a rejected receipt (`commandProcessing.ts:341-361`); neither acceptance nor Undo raises one (both map errors to persistence errors), so a transient SQL failure cannot poison an operation id. See R6 for the guard I still recommend.
- Streaming deltas do not change raw facts: the thread projector only bumps `updated_at` on `thread.message-sent` (`ProjectionPipeline.projector.threads.ts:290-301`), which the raw-fact query does not read.
- The native process still serializes frames (one `write` per frame, `organizationNative.process.ts:128`) and the heartbeat sequence is read after the fact write resolved (`publisher.ts:40-49`), so Rust's "heartbeat ahead of facts" check (`session.rs:86-93`) cannot trip.

## New findings

### R1 — Stale re-proposal reuses the occurrence and operation identity; the ledger refuses it as a real fault

- `session_operations.rs:85-92`: `occurrence_id` is a digest of `(nonce, generation, admitted fact sequence, proposal without ids/created_at)`; `operation_id = identity(occurrence, 0)`; `created_at_ms` is set afterwards.
- After a `stale` receipt the thread is blocked on its own `fact_version` with a 1 s doubling backoff (`:148-169`); when it lifts (`:42-50`) and the row is unchanged, `scheduler.next` returns the identical `Movement` and `start` produces the **same** `occurrence_id` and `operation_id` with a **new** `created_at_ms`.
- TS: `ThreadOrganizationOperations.ts:19-37` includes `createdAtMs` in the canonical digest; `:84-88` finds the existing row by `operation_id`, the digest differs → `conflict`. `organizationBridge.proposals.ts:57-59` turns `capacity`/`conflict` into a plain `Error`, so `OrganizationFailureGate` fences immediately: child killed, resnapshot, **3-in-30 s budget consumed**.
- The Rust test `session_tests.rs:243-271` sends a fact for an unrelated thread (`fact(2, …)`, `fact(3, …)`) between the stale receipt and the re-proposal, which changes the admitted sequence and hence the identity; it therefore never exercises the quiet case. The TS proposals test uses a stubbed ledger.

Trigger: a `stale` verdict for a reason that does not change the row and no other fact arrives before the backoff lifts. Realistic paths: the ≤1 s window between a settings save and the policy frame (acceptance already uses the new fingerprint; Rust still proposes under the old version; if the frame arrives before the backoff lifts the version changes and the identity differs, otherwise it does not), and any future row-independent stale. Narrow, but the identity contract in A3 ("new attempt identity only after a confirmed not-due; identity unique per attempt") must not depend on unrelated fact traffic.

Fix (small): in `Operations::start`, mix a per-session proposal counter (or `now_ms`) into the occurrence digest so every new attempt-0 proposal is unique while retransmissions stay byte-identical. Keep the TS `conflict` behaviour (identity reuse must stay fail-closed). Tests: Rust — two stale receipts with **no** intervening facts yield distinct `occurrence_id`s; TS — `organizationBridge.proposals` against the real ledger: stale → re-proposal is `prepared`, not `conflict`.

### R2 — Live-capture overflow is a real fault, not a resync

- `OrchestrationEngine.deliveryHub.ts:52-58`: on overflow the merged capture stream **dies** (`Effect.die(new Error("… live capture overflowed"))`) and the queue is shut down (`:65-70`).
- `organizationBridge.ts:85-86, 89-100`: the consumer is wrapped in `guard`, whose `Cause.squash` yields that plain `Error` → `gate.fail(plain)` → immediate fence as a native fault.
- The resync classification only lives in the observation pass's poll of `isOverflowed` (`organizationBridge.loops.ts:91-92`), which runs every 200 ms; the die fires first. `organizationBridge.loops.test.ts:178-179` covers only the poll path.

Impact: bounded (overflow needs 2000 queued events or 8 MB before a cheap marker fiber runs), but it is exactly the "routine condition consumes the budget" class H3 was meant to close. Fix: in the capture consumer's catch, map the failure to `OrganizationResync` when `isOverflowed` is true (or always, since the consumer has no other failure mode); add a test that overflows the capture and asserts the lifecycle sees a resync.

### R3 — Snapshot capture budget is a fixed 120 s regardless of row count

- `organizationSnapshot.capture.ts:10, 39-42`: 120 s wall budget, `OrganizationResync` on expiry; `ORGANIZATION_LIMITS.liveRows = 100_000` (`organizationProtocol.ts:6`).
- Every attempt restarts from the first page and re-observes every row (two raw-fact queries plus owner sampling plus a write transaction per row, `organizationFacts.store.ts:24-77`). Rows already stored are `unchanged` on later attempts, but the reads still run, so progress does not shorten the pass.
- If a read-only pass over the table exceeds 120 s, the capture **never completes**: resync, 2 s → 60 s spacing (`organizationLifecycle.ts:62-66`), repeat for ever with status `syncing` and roughly a two-thirds duty cycle of heavy reads on the database. The 1 ms-per-row implied by the budget and the limit (100 k rows in 120 s) is not realistic for this query shape.
- Separately, `rows.length > liveRows` (`capture.ts:52-53`) is a plain `Error`: three fast attempts latch paused, the 5 min cooldown retries, and each retry captures 100 k rows before failing again, for ever.

Impact: the user's known large userdata is the case this matters for; A4/A15 cannot be claimed for it without a measurement. Fix: scale the budget with the membership count (for example `max(120 s, rows × 10 ms)`, capped) or resume the cursor across attempts; make "limit exceeded" a distinct terminal status that waits only on the retry signal, logged once. The synthetic fixture now gives roughly 0.6 ms per row in memory with no history (addendum); one on-disk measurement with real event history is still needed to pick the constant.

### R4 — A deferred resync from the heartbeat fiber leaves the owner silent

- `organizationBridge.ts:191-192`: each loop is `Effect.forever(step)`; a failing step ends the fiber. The heartbeat's clock-discontinuity resync (`loops.ts:49-52`) therefore terminates the heartbeat fiber before `gate.fail` runs.
- `organizationBridge.failure.ts:15-21` defers the resync while a proposal is in flight. During that deferral no heartbeat reaches Rust and `owner.observedAtMs` stops advancing. If the proposal takes longer than 15 s, Rust's owner timeout (`session.rs:146-148`) exits the child, which TS reports as `native organisation process exited` — a **real** fault.

Impact: needs sleep/wake (or a 75 s clock step) coinciding with a slow proposal; low frequency, bounded to one budget unit. Fix: let the heartbeat step report a resync to the gate and keep beating (catch `OrganizationResync` inside the heartbeat loop and call `fail` without ending the loop), or bound the deferral at `nativeSilenceMs − margin` and fence as a resync.

### R5 — Overflow rescan cannot recover a dropped deletion

`organizationObservation.ts:8-15` drops the id when the set is full; the rescan pages `projection_threads WHERE deleted_at IS NULL` (`organizationFacts.query.ts:91-96`), so a dropped `thread.deleted` mark leaves the row in `rows` and in Rust's state until a proposal for it is refused and `refresh` publishes the tombstone (`publisher.ts:65-78`). Self-healing and bounded. Fix: after a sweep that followed a rescan completes, mark every key of `rows` not seen during the sweep.

### R6 — Recovery has no exit for a persisted command rejection

`organizationBridge.startup.ts:54-59` fails the attempt when a pending operation's dispatch does not yield an outcome. Today no path persists a rejected receipt for `thread.organization.react` (see regression checks), so this is unreachable; if one is ever added, a single prepared row would pause the organiser permanently (3 fast failures → cooldown → repeat). Guard: on `OrchestrationCommandPreviouslyRejectedError`, settle the ledger row as `stale` and continue.

### R7 — Residual observation load on tool-heavy turns

`organizationObservationIds` (`organizationObservation.ts:26-32`) marks a thread for every thread event except assistant message deltas, so every tool activity on an active thread triggers an observation (two heavy reads, owner sampling and a short write transaction) at up to one per 200 ms pass. Three tool-heavy threads ≈ 30 heavy queries per second while they run. Fix: a per-thread minimum refresh interval in the observation set (for example 1 s unless the event is an attention kind, a turn boundary, an organisation update or a deletion), or filter non-attention activity kinds before marking.

### R8 — The TS 30 s "unsettled" bound is behind Rust's own ack budget

Rust retransmits at 5.2/5.4/5.8 s and exits after the third retry (`session_operations.rs:184-199`, about 22 s), so `ORGANIZATION_PROPOSAL_UNSETTLED_MS = 30_000` (`organizationBridge.proposals.ts:19`) is effectively unreachable and the fault shows up as a child exit instead. Consistent with the agreed contract; document it or set the TS bound to the Rust budget so the error message names the actual cause.

### R9 — Copy and polling nits

- The paused copy differs between the sidebar (`Sidebar.inyosiraStatus.tsx:30-33`) and Settings (`InyosiraIdleSettingsSection.tsx:96-99`); the Settings line omits the recovery paths. Share one string.
- The policy follower reads settings and the DB policy row every second (`organizationBridge.policy.ts:39-47`, `organizationBridge.ts:237-253`). Cheap, but it could subscribe to `settings.streamChanges` and only read the barrier after an Undo signal.
- `requestOrganizationRecovery` fires inside the command transaction before commit (`organizationFacts.events.ts:103`); a rolled-back move still wakes a paused lifecycle. Harmless.

## Known unfinished items: blocker or bounded qualification?

| Item                                       | Classification                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-process lost-ACK kill/restart test   | **Closed as bounded qualification** by `organizationRecovery.process.test.ts` (addendum): real Rust scheduler, real engine and ledger in forked Node processes, SIGKILL after durable preparation and after canonical commit before receipt; the replacement converges on one move, revision 1, no pending operations, with the exact stored outcome. R1 is outside its reach because the replacement Rust session starts fresh. |
| Timed 5 k/10 k synthetic DB                | **Closed for ordinary databases** by `organizationSnapshot.scale.test.ts` (addendum): 10 k rows captured in 5.7 s in memory with a write admitted between rows and a 32-row bounded pass. The large-database claim still rests on R3: the budget is fixed, every attempt restarts from the first row, and the on-disk cost with real history is unmeasured.                                                                      |
| No explicit Retry control                  | **Not a blocker.** Settings change, deliberate move and the 5 min cooldown all clear paused (`organizationLifecycle.ts:47-56`, `ThreadOrganizationReactor.ts:33-36`); restart remains a hatch, which satisfies the agreement.                                                                                                                                                                                                    |
| Fallback-fenced delivery never toasts      | **Not a blocker.** Moves are unaffected; toasts are secondary. Record it in the changelog or help copy as a known limitation of the degraded mode.                                                                                                                                                                                                                                                                               |
| Packaged Windows/macOS/Linux qualification | **External qualification; blocker for a release/production claim, not for code acceptance.** Unchanged from the first review (verifier wiring, Windows ARM64 step, standalone packaging, two-socket engagement).                                                                                                                                                                                                                 |

## Acceptance matrix (after this re-review)

| ID     | Status                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------ |
| A1     | Met in source; liveness fixes verified. R1/R2/R4 are budget-classification gaps, not liveness regressions                |
| A2     | Met (bounded wire, coalesced observation, paged capture); R7 is cost, not correctness                                    |
| A3     | Met for ledger/fencing/receipts; **R1 violates the per-attempt identity contract** until fixed                           |
| A4     | Met in source; **large-DB claim blocked by R3** until the budget is sized or made resumable                              |
| A5–A10 | Met (unchanged)                                                                                                          |
| A11    | Met                                                                                                                      |
| A12    | Met                                                                                                                      |
| A13    | Met (sequence frontier, server-time cap, automatic-only event toasts, own-outcome manual confirmation)                   |
| A14    | Met                                                                                                                      |
| A15    | Met for recovery paths; R2/R4 still let routine conditions consume the budget; R3's limit case loops instead of stopping |
| A16    | Packaging wired; native qualification outstanding                                                                        |
| A17    | Met for every file read; M6/M7 duplicates removed                                                                        |

## Fix plan (ordered)

1. **R1** — Rust occurrence uniqueness (`session_operations.rs:85-92`) plus the two tests named above.
2. **R2** — capture consumer failure → `OrganizationResync` (`organizationBridge.ts:89-100`); overflow test through the lifecycle.
3. **R3** — size-scaled or resumable capture budget; distinct terminal status for the row limit; use the synthetic in-memory rate as the floor and add one on-disk measurement with real history to pick the constant.
4. **R4** — heartbeat survives a deferred resync (`organizationBridge.ts:191-197`, `loops.ts:46-70`).
5. **R5–R9** — tombstone after rescan, recovery rejection guard, per-thread refresh interval, bound alignment, copy/polling nits.
6. Re-run the focused organiser/runtime server suites, Rust crate fmt/clippy/tests and the configured typechecks; then the native/packaged qualification matrix before any production or release claim.

No source was changed, no checks beyond formatting this report were run, nothing was staged or committed, and no live userdata or provider was touched.

## Addendum — crash and scale tests added after this re-review

No `.ts`, `.rs` or `.proto` file under `apps/server/src` or `crates` is newer than this report, so the verdict above still describes the current source. The three new files were read in full and checked against the modules they exercise.

### Cross-process crash and recovery (`organizationRecovery.process.{fixture,test}.ts`)

What it exercises:

- A real `bigbud-desktop-supervisor` binary (`fixture.ts:20`), the real engine, ledger and bridge in a forked Node child (`test.ts:39-41`). Only `thread.organization.react` is intercepted (`fixture.ts:72-93`): `prepared` hangs after the ledger has durably prepared the operation (the production order is prepare, then dispatch: `organizationBridge.proposals.ts:57-60`); `committed` lets the canonical command commit and the ledger settle in the same transaction, reads the stored outcome, then hangs before any receipt (`fixture.ts:83-92`). The parent kills the child with SIGKILL (`test.ts:70, 85`).
- The replacement process runs `recoverOrganizationOperations` (`organizationBridge.startup.ts:50-59`) before its bridge exists. For `prepared`, the replay reaches acceptance with no process-local owner (`organizationAcceptance.ts:43, 81-98`) and settles `stale`, which is the documented "never replayed under a replacement native identity" rule; the new bridge then proposes the move itself. For `committed`, the replay resolves as a ledger duplicate (`ThreadOrganizationOperations.ts:84-88`) and returns the stored outcome, compared exactly including sequence and revision (`test.ts:95`).
- Both phases converge on one `thread.organization-updated` event, revision 1, no pending operations and an active replacement owner (`fixture.ts:107-121`, `test.ts:88-94`).

What it proves: operation identity and the stored outcome survive process replacement at both durable barriers, with no duplicate move, against the real scheduler. That is the lost-ACK contract from H4/A3 and A15 under a real kill.

What it does not prove (bounded, none a blocker):

- `classifyOwner` is forced to `"dead"` (`fixture.ts:34`), so backend-owner liveness classification and lock takeover are not exercised here.
- The old Rust child exits through pipe EOF (`crates/bigbud-desktop-supervisor/src/organization/runtime.rs:1`), not through the supervisor's SIGTERM/SIGKILL shutdown path (`organizationNative.process.ts:141-157`). The owner's process-absence check covers the outcome empirically.
- The replacement Rust session starts fresh, so R1 (same occurrence identity re-proposed after a stale backoff within one session) is untouched. R1 stands.
- The test is skipped when the debug binary is absent (`test.ts:76`). A CI job without a Rust build loses it silently. Recommended: assert the binary's presence in the integration job, or fail instead of skip when a `BIGBUD_*` variable says the binary is required.

### Scale (`organizationSnapshot.scale.test.ts`)

- 5 k and 10 k synthetic rows in an in-memory database with no event or activity history (`test.ts:18-27`), default 120 s budget, grace 300 000 ms (inside the store's 120 s–600 s bound, `organizationFacts.store.ts:22`).
- The write issued from the owners callback at the 50th sample (`test.ts:38-47`) runs between row transactions, because the store samples owners before opening its transaction (`organizationFacts.store.ts:34-35`). That demonstrates the H2 property (no transaction spans rows) and that a later row observes the write (`section` 3 assertion, `test.ts:89`). It is not a cross-connection lock measurement; the server runs one connection, so this is the realistic shape.
- One bounded observation pass refreshes at most 32 rows in under 2 s (`test.ts:93-96`), confirming the H1 cap on a sized table.
- Owner's numbers: 5 k in 3 193 ms and 10 k in 5 656 ms, roughly 0.6 ms per row. Extrapolated to the 100 k `liveRows` limit that is about 60 s in memory with no history, half the fixed budget. On disk with real history the per-row raw-fact query is heavier and unmeasured. R3 is narrowed, not closed: ordinary databases are well inside the budget; the user's known large userdata still has no measurement, and the fixed budget, restart-from-first-row and plain-`Error` limit case remain as written.

### Final acceptance decision

- **Accepted for integration.** The migration as implemented matches the agreements (authority split, fencing, ledger, serialized final recheck, scheduler semantics, aging, Undo, UI order, packaging wiring). Remediation of C1, C2, H1–H4, M1–M9, L1, L2, the lifecycle addendum and D1 is verified in source, and the new crash and scale tests are sound and close the lost-ACK and synthetic-size items as bounded qualification.
- **Required before cutover** (small, bounded fixes): **R1** (`session_operations.rs:85-92`, occurrence uniqueness per attempt), because any stale final recheck in ordinary use becomes a ledger `conflict`, a real fault and, three times in 30 s, a 5 min pause; and **R2** (`organizationBridge.ts:89-100`, capture overflow as `OrganizationResync`).
- **Required before claiming large-database support:** **R3**.
- **May follow cutover:** R4–R9 and the binary-presence guard above.
- **External qualification, not code acceptance:** packaged Windows/macOS/Linux and Windows ARM64, release workflow execution, standalone packaging end to end, real two-socket engagement.

No source was changed in this addendum pass, no checks beyond formatting this report were run, nothing was staged or committed, and no live userdata or provider was touched.
