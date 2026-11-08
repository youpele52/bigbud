# Inyosira native organiser — independent Fable 5.1 review

**Date:** 6 November, 2026
**Reviewer:** delegated Fable 5.1 thread (read-only; no source edits, no checks beyond reading, no commits)
**Subject:** the actual dirty checkout of `dev` at `70cc1ebb76`, all organiser-authored work (TS bridge/acceptance/facts/Undo/engagement/notifications/settings, Rust `organization/` runtime, migrations 146–151, packaging and release workflow changes)
**Authority:** product agreements supplied by the user override stale plan text. Row-baseline work (migration 152, baseline row rewrite), workspace, UI/project-name and connection-resilience hunks were not reviewed and must be preserved.

## Verdict

**Not ready for cutover acceptance.** The architecture matches the agreed boundary (TS keeps DB/canonical authority, Rust is the single live scheduler, no TS fallback, bounded frames/queues/ledger, generation fencing, durable lost-ACK identity, serialized final recheck). The remaining problems are concentrated in the TS bridge's observation loop and are severe enough that, under ordinary chat usage or on a large database, automatic organisation would restart continuously and then latch itself paused. Two of them are correctness-of-liveness bugs, not polish. Everything else is medium or lower and is listed with a concrete fix.

Evidence basis: source reading of every file named below, cross-checked against the focused test files that exist. I did not run tests, the app, live userdata or any provider; test results quoted by the integration owner are theirs, not mine, and pure tests are not deployed qualification.

## Findings

Severity: **Critical** = will break the feature in normal use; **High** = breaks under realistic load/size or violates an agreement; **Medium** = correctness/robustness gap with bounded impact or a maintainability rule violation; **Low** = polish.

### C1 — `refresh` treats a routine frontier race as a fatal bridge failure

- `apps/server/src/thread-organization/organizationBridge.ts:206-213` fails the whole bridge on `observed.status === "stale"`.
- `apps/server/src/thread-organization/organizationFacts.store.ts:31-37` returns `stale` whenever `frontier < thread_organization_runtime.canonical_frontier`.
- `canonical_frontier` is advanced by `recordOrganizationRuntimeEvent` (`organizationFacts.events.ts:33,93`) inside **every** canonical command transaction that touches organisation facts (human message, prompt queued, approval/input/model-choice activity, any organisation event) and by `observe` itself.
- The bridge reads `frontier` once per event job (`:304-308`) and once per tick (`:337-340`), then runs up to 256 `refresh` calls with that stale value (`:341-342`).

Failure scenario: the user sends a message (or a provider raises an approval) while the tick loop is partway through its 256-row pass. The next `observe` sees `frontier < canonical_frontier`, returns `stale`, the bridge fails with "organisation fact observation raced", the child is killed, the owner is fenced, a full snapshot is recaptured. This is a plain `Error`, not `OrganizationResync`, so it consumes the 3-in-30s failure budget (`organizationLifecycle.ts:22-35`). Three such races inside 30 seconds latch automation **paused until server restart**. With the per-second rescan (H1) the race window is effectively always open on any active workspace. The existing store test (`organizationFacts.store.test.ts:56-87`) only proves `stale` is returned for a raw-row race; nothing tests the bridge's reaction.

Fix: make `stale` a retry, never a failure. Preferred: have `observe` read the orchestration frontier **inside** its own write transaction (`orchestrationSequenceFrontierSql`) and return it with the row, so `sourceFrontier` is always ≥ `canonical_frontier` and monotonic; the bridge then uses the returned frontier for the fact frame. Alternative: in `refresh`, on `stale` re-read `readOrganizationFrontier` and retry up to N times before failing with `OrganizationResync`. Add a bridge-level regression that commits a canonical event between the frontier read and `observe` and asserts no restart.

### C2 — Every domain event on a thread (including streaming deltas) triggers a full fact observation; overflow is a fatal failure

- `organizationBridge.ts:83-99` offers one `event` job per captured event for any `aggregateKind === "thread"` with no type filter and no coalescing.
- Each event job runs `readOrganizationFrontier` plus `refresh` → `observe` → two `readOrganizationRawFacts` queries (each with the global model-choice CTE and six correlated `EXISTS` subqueries), two owner samples and a write transaction (`organizationFacts.store.ts:21-62`).
- `thread.message-sent` streaming deltas are canonical events (`deciderThreads.turn.ts:203,218`), so a streaming assistant turn produces tens of observations per second for that thread.
- The work queue is `Queue.dropping(2000)` and a dropped offer calls `fail(...)` (`:64-79`), a non-resync failure that counts toward the paused latch. `capture.isOverflowed` (`:250-251`) has the same effect.

Failure scenario: two or three threads streaming at once on a large database. Observations cannot keep up, the 2000-slot queue drops, the bridge fails, resnapshots, repeats, and latches paused within 30s. Even without overflow this is a continuous write-transaction load competing with the serialized command processor.

Fix: coalesce event jobs into a bounded `Set<threadId>` of dirty threads drained once per loop iteration (ordering between a thread's own facts is preserved because `observe` reads current DB state; only observational refreshes coalesce, which the plan permits). Filter obviously irrelevant event types (assistant deltas, usage, diff) before offering. Treat queue overflow as a "mark all dirty, full rescan" condition rather than a failure. Add a test that pushes >2000 delta events through the capture and asserts no restart and one observation per thread.

### H1 — Per-second full-table rescan with per-row heavyweight queries

- `organizationBridge.ts:245-247` ticks every 1s; `:337-343` reads a 256-row page of raw facts each tick and calls `refresh` on **every** row, i.e. 256 × (2 raw-fact queries + owner sampling + a write transaction) per second, cycling through the entire table forever.
- `readOrganizationRawFacts` with `threadId` undefined runs the unscoped `MATERIALIZED` model-choice CTE over all delegation activities on each page (`organizationFacts.query.ts:41`, `DelegatedModelChoiceSql.ts`).
- Heartbeats to Rust are sent from the same single loop (`:336`). Rust exits if it sees no owner frame for 15s (`session.rs:133-135`); TS exits if no native frame is processed within 15s (`:312`). On the user's known 16GB userdata, where even `getSnapshot` fails to complete, a 256-row pass can exceed 15s, so each tick becomes a heartbeat failure and a restart.

Fix: restore the previous 15s sweep cadence for the rescan (the plan's parity requirement), keep the 1s tick only for heartbeat/policy checks, and bound the per-tick refresh budget (e.g. 32 rows or 200ms wall time, resume from `scanAfter`). Send heartbeats from a separate forked fiber so a slow pass cannot starve them. Scope the model-choice CTE per page (join on the page's thread IDs) or precompute it once per pass. Add a timing test with a seeded 5k-row fixture asserting bounded per-tick DB time.

### H2 — Snapshot capture is one unbounded write transaction over the whole table

- `organizationSnapshot.capture.ts:36-70` opens a single `withTransaction` and, inside it, re-reads every page and calls `store.observe` for every row (each itself a nested write transaction with two more raw-fact reads). For N live threads that is ~3N heavy queries holding the SQLite write lock; the command processor, chat and manual moves block for the duration.
- The first pass (`:23-35`) also samples terminal/shell owners for every thread before launching the child; nothing bounds its wall time, and the Rust-side snapshot budget (10s progress / 60s total, `session.rs:139-145`) starts only after launch, so the plan's "snapshot budget must cover capture" requirement is unmet.

Fix: capture in bounded pages, each its own short transaction, persisting rows as you go; take the frontier before the first page and verify it has not moved past `canonical_frontier` at the end (or accept a bounded number of refreshes for rows that changed, using the C1 fix). Add a capture wall-time budget that fails with `OrganizationResync` and reports "syncing" rather than blocking commands. Test with a 10k-row fixture that a concurrent manual move commits within a bounded time during capture.

### H3 — Non-resync failure classes that are routine in practice

The lifecycle now exempts `OrganizationResync` (policy fingerprint change, target barrier change) from the failure budget — good. These remain plain failures and should not be:

- Clock discontinuity > 75s or backwards (`organizationBridge.ts:329-332`): every laptop sleep/wake counts as a native failure.
- "thread disappearance requires resync" (`:219-221`) when a projection row vanishes without a tombstone (e.g. projection rebuild/baseline restore).
- Queue overflow and capture overflow (C2).

Fix: raise these as `OrganizationResync` (or a third class "expected resync" with its own, longer budget) so only genuine native/transport faults (child exit, malformed frames, ACK timeout, write timeout) consume the paused budget. Also give the paused latch a recovery path: a settings change or a server-side "retry" should clear `attempts`; today `Effect.never` at `organizationLifecycle.ts:23-26` means paused is permanent until restart, which the agreement ("Restart is a recovery hatch, not a substitute") argues against.

### H4 — Proposal handling can exceed the 5s receiver bound under ordinary command latency

- `organizationNative.process.ts:195-213` rejects a native frame if the bridge callback takes > 5s; `consume` failure calls `fail` → child killed, non-resync failure.
- The proposal path (`organizationBridge.ts:262-298`) performs ledger prepare, a serialized `engine.dispatch` (queued behind every other canonical command), ledger read, frontier read, a full `refresh` and the receipt send before resolving `done`.
- Rust independently retransmits after 5.2/5.4/5.8s and gives up after 3 retries (`session_operations.rs:160-176`), which is the agreed contract; the TS 5s receiver timeout is the problem because it turns slowness into a crash instead of a late receipt.

Failure scenario: a large workspace command (project reconfigure hydrating all threads, `OrchestrationEngine.prepareCommandState.ts:522-530`) or H2's capture holds the command queue for 6s; the proposal frame times out, the bridge fails, resnapshots and the cycle repeats on the next proposal.

Fix: acknowledge receipt of the frame to the process immediately (resolve `done` after enqueue), and let the receipt frame carry the eventual outcome; keep Rust's retransmit/dedup (the ledger already makes duplicates idempotent via `operations.prepare` → `duplicate`). Keep a separate, longer bound (e.g. 30s) on "proposal still unsettled" as the failure condition. Test: inject a 7s command ahead of the proposal and assert the bridge survives and sends one receipt.

### M1 — Settings and Undo changes force a full resnapshot although Rust can apply a policy update in place

- `organizationBridge.ts:315-328` fails with `OrganizationResync` on any policy fingerprint or target-barrier change.
- `scheduler.rs:95-117` has `Scheduler::update_policy` with proper barrier handling, but no wire frame delivers a policy update, so it is dead code. The M1 exit criterion said unused APIs must be used or removed.
- Every successful Undo advances `target_drain_not_before_ms` (`organizationUndo.ts:99`) and therefore triggers a full child restart and table resnapshot.

Fix: add a `policy` frame (begin-compatible `Policy` message) to the protocol, have Rust call `update_policy`, and reserve resnapshot for generation faults. Until then, at least debounce: do not resync while a proposal is in flight, and coalesce multiple barrier changes.

### M2 — Rust re-proposes a stale operation as soon as any unrelated fact arrives

- `session_operations.rs:135-145` blocks a thread after a `stale` receipt keyed on `(fact_version, sequence)`; `allows_thread` (`:33-38`) lifts the block when **any** fact advances the global sequence, even for a different thread.
- TS returns `stale` for reasons that do not change the thread's row (owner observation older than 75s, policy fingerprint mismatch, `createdAtMs > nowMs` skew, `!unchanged` due to an engagement lease refresh).

Failure scenario: a busy workspace streams facts for other threads; a thread whose proposal was vetoed for a row-independent reason is re-proposed on every tick, each costing a serialized acceptance transaction, until the underlying reason clears.

Fix: block on the thread's own `fact_version` only (lift when **that** row's version changes), plus a capped exponential backoff per thread for repeated `stale` outcomes (the plan prescribes 1s minimum, 60s cap for not-due; apply the same to stale). Test: two stale receipts at the same fact version with unrelated facts in between must not produce a third proposal before the backoff.

### M3 — Pre-activation TS heartbeat budget (5s) is inconsistent with the Rust snapshot budget (10s/60s)

- `organizationBridge.ts:312` fails if no native frame is processed within 5s before `ready`; `lastNativeAt` is initialised after the snapshot frames are sent (`:202`).
- A 100k-row snapshot is up to ~400 pages that Rust must decode, validate, digest and buffer; `ready` can legitimately take longer than 5s.

Fix: before `ready`, use the same 60s total / 10s-progress budget as Rust, counting a `heartbeat`-less period as progress while `send` promises are still resolving.

### M4 — Notification frontier is wall-clock based, not sequence based

- `apps/web/src/lib/organizationNotifications.ts:10-19` keeps an event only if `occurredAt` (server clock) lies within `(connectedAt, now]` (client clock) and is less than 15s old.
- The plan requires a **sequence** frontier recorded at bootstrap/reconnect. `-__root.logic.tsx:300-301` already filters by `event.sequence > previousSequence`, so the sequence is available.

Failure scenario: remote server (SSH/Tailscale) whose clock is 20s ahead → every confirmed move is dropped (`at <= now` fails); clock 20s behind → every move is dropped (`now - at < 15000` fails). Toasts silently never appear, and the manual-move confirmation copy never shows.

Fix: record the delivery sequence at connection time and admit events with `sequence > connectionFrontier`; keep a bounded age guard only as a secondary cap, computed from server-supplied times (e.g. compare `occurredAt` to the latest event's `occurredAt`, not to client `Date.now()`).

### M5 — Deliberate-move toasts fire for every connected client and for Undo restorations

- `organizationNotifications.delivery.ts:30-37` toasts every `reason: move, source: deliberate` event on the connection, regardless of which client issued it. Another user's (or another window's) manual move produces "Moved to Later …" here. An Undo restoration is also `source: deliberate` (`organizationUndo.ts:86-89`), so a successful Undo shows a second "Moved to Present" toast with the 10-minute copy after the automatic group's toast.
- The plan says manual confirmations use canonical **command outcome** recovery, i.e. the issuing client confirms its own command.

Fix: show the deliberate confirmation from the client's own dispatch outcome (where the move originates), and in the event path only group **automatic** moves. Distinguish Undo restorations (e.g. an `undoOf` marker in the event payload, additive) so they do not re-toast as manual moves.

### M6 — Legacy TS scheduler code still ships in production modules

- `ThreadOrganizationReactor.idle.ts` and `ThreadOrganizationReactor.snooze.ts` remain production (non-test) modules producing `thread.organization.idle` / `snooze.expire` commands; `OrchestrationEngine.terminalIdle.ts:7` imports `idleRulesFor` from the idle scheduler. The reactor layer no longer starts them, which satisfies "single live scheduler", but the plan's M3 exit required removing production imports and keeping only reference fixtures. The decider still accepts `thread.organization.idle`/`snooze.expire`, so any future internal caller re-creates a second scheduler silently.

Fix: move `idleRulesFor` into a settings-logic module, relocate the two schedulers to `*.fixture.ts`/test-only paths, and add a static test asserting no production module imports them (the integration report says a static assertion was replaced with the functional test; both are useful).

### M7 — Two write paths for `thread_organization_runtime_threads` with divergent semantics

- `persistence/Layers/ThreadOrganizationRuntime.transitions.ts` (`recordTransition`, exported via the repository) and `thread-organization/organizationFacts.events.ts` + `organizationFacts.store.ts` all upsert the same table. The hook writes the literal `transition_digest = 'canonical-organization'` and the store writes a real digest; `recordTransition` has its own completion/deliberate anchor rules that nothing in production calls.
- AGENTS.md: duplicate logic across files is a code smell; the plan required one repository to own this table.

Fix: route the hook and the store through `recordTransition` (extend it with the few columns they need: attention IDs, reminder, semantic digest, last work state), or delete `recordTransition` and its tests if the inline SQL is the chosen owner. Do not keep both.

### M8 — Existing-install banner logic ignores an explicit "off" and overwrites a configured target

- `Sidebar.inyosiraStatus.tsx:31` shows the banner while `enabled !== true`, so a user who explicitly set the target **off** in Settings keeps seeing it until "Not now".
- `:18` "Enable" writes `inyosiraPresentTarget: 7`, overwriting a target the user may already have set in Settings before enabling.
- The Settings switch (`InyosiraIdleSettingsSection.tsx:112-113`) correctly marks the introduction dismissed; the banner should treat `enabled === false` the same way.

Fix: banner condition `enabled === null && !dismissed`; "Enable" sets only `inyosiraPresentTargetEnabled: true` and `inyosiraIntroductionDismissed: true`.

### M9 — Rust decision pass is O(rows) per received fact

- `session.rs:162-183` sets `dirty` on every admitted fact/receipt and then collects a `Vec` of all rows and runs the full scheduler (`scheduler.rs:122-183`, several linear passes) on the next 100ms tick.
- With C2/H1 producing hundreds of facts per second on a 100k-row state, this is hundreds of 100k-element passes per second.

Fix: rate-limit decision passes (e.g. at most every 250ms when dirty) and keep the 15s idle reschedule. Keep correctness unchanged; this is cost only.

### L1 — Snooze row invariant can kill the child on a half-cleared projection row

- `admission_validation.rs:32` rejects a row where `snooze_until_ms.is_some() != snooze_identity.is_empty()`. `buildOrganizationFacts` passes both columns straight from `projection_threads`. The decider always writes both together, so this is only reachable through a hand-edited or partially restored row, but the consequence is a resync loop with no visible cause.

Fix: treat an inconsistent snooze pair as "snoozed with unknown deadline" (protect, never schedule) on the TS side and log once.

### L2 — Status polling and engagement details

- `useOrganizationStatus.ts:25` polls every 5s per mounted instance (sidebar and settings both mount it). Fine for now; consider a single store.
- Engagement is only pushed to Rust through the rescan (no event is produced on lease changes), so Rust's `engaged_until_ms` view lags by up to one rescan pass. Final acceptance re-reads the live lease (`organizationFacts.owners.ts:32-34`), so safety holds; after H1 lengthens the sweep, publish a lightweight fact refresh for the engaged thread from the RPC handler instead.

## What is correct and should be preserved

- Authority split: `OrchestrationEngine.commandProcessing.ts:337-373` runs acceptance/Undo inside the serialized canonical transaction, settles the ledger and the receipt in the same transaction, and the runtime hook runs after projections. Startup recovery resolves pending operations only against durable receipts and fences them stale under a new generation.
- Final acceptance (`organizationAcceptance.ts:38-105`, `organizationProposal.validation.ts`) independently rechecks owner/generation, policy fingerprint from **current** settings, fact version, revision, section, snooze identity, current work/attention/engagement/grace/manual, global Present count and the persisted drain barrier, and refuses with typed `stale`/`not-due`. No optional bypass exists; the client schema does not expose `thread.organization.react` (`orchestration.commands.client.ts:354-387`).
- Rust admission is fail-closed with bounded staging, digest/page/count validation, duplicate-field rejection and monotonic version/revision/watermark checks; the session serializes one in-flight proposal with identical-payload retransmission and new attempt identity only after a confirmed not-due.
- Scheduler semantics match the agreements: reactions before cleanup; new attention interrupts manual and snooze while existing requests do not; manual override is fixed 10 minutes with Needs-you-then-Present-if-active expiry; full snooze deadline; unknown work protects; target drains least-recently-active eligible inactive rows, never active ones, and stays silently over target when all are protected; older-before-short with persisted older barrier and short barrier reset on discontinuity.
- Source-aware aging: `organizationWithAge`, `ProjectionThreads.organization.ts` and `organizationActivitySql` share one definition; the backfill walks 100 indexed stream rows per transaction with a durable cursor and conservative fallback; baseline capture/restore of the anchors is covered by the baseline tests the integration owner reports.
- Undo: conditional on current revision, latest automatic identity, attention watermark, work/attention safety; grants per-thread grace and a global drain barrier transactionally; idempotent via the command receipt.
- UI order Needs you, Present, Later, Done is driven by `THREAD_ORGANIZATION_STATES`, so keyboard and mod+number navigation follow; Needs-you rows keep the running indicator because `SidebarThreadRow.tsx:122-136` derives it from provider status, not section. Opening a thread sends engagement only.
- Packaging: desktop builds copy `server-organization-supervisor-<platform>-<arch>` next to the workspace agent (`verify-packaged-workspace-agent.ts:70-85`), Windows ARM64 is built in `release.yml:233-242`, and the assembled verifier requires all five. The split `release-desktop-build.yml` is a verbatim move. This is local YAML/interface reading only.

## Required missing tests

1. Bridge survives a canonical event committed between frontier read and `observe` (C1), with no child restart.
2. > 2000 streaming delta events on three threads: no overflow failure, bounded observations per thread (C2).
3. Seeded 5k-row fixture: per-tick DB time bounded; heartbeat cadence to Rust never exceeds 10s during a pass (H1).
4. 10k-row snapshot capture does not block a concurrent manual move for more than a bounded time; capture over budget resyncs with "syncing" status (H2).
5. Sleep/wake (clock jump > 75s) resynchronises without consuming the paused budget; paused state recovers after a settings change (H3).
6. Proposal whose acceptance is delayed 7s by a preceding command: one receipt, no restart (H4).
7. Two `stale` receipts at the same fact version with unrelated facts in between: no third proposal before backoff (M2).
8. Notification admission by sequence frontier with skewed client clock ±60s (M4); another client's manual move produces no toast here; Undo restoration produces exactly one toast (M5).
9. Real-process lost-ACK at each boundary (kill the TS side after dispatch commit but before receipt send; restart; assert identical outcome and no duplicate move). The current engine test replays within one process only.
10. Static assertion that no production module imports the legacy idle/snooze schedulers (M6).
11. Banner hidden when target explicitly off; Enable does not overwrite a configured target (M8).

## Qualification gaps (not bugs; must be reported honestly before any production claim)

- No macOS/Windows/Linux packaged run of the organiser mode; `verify-packaged-workspace-agent.ts` now hard-requires a packaged supervisor and runs the protocol smoke on it, so the first real release run is the qualification.
- Windows ARM64 release step imports a `.ts` module via `node --input-type=module -e` (`release.yml:242`); Node 24 strips types by default, but this has not executed in CI.
- Headless/standalone server packaging (`cli.ts build` now cargo-builds the supervisor on the host) has not been run end to end; `organizationNative.config.ts` candidate paths for standalone `dist/organization-supervisor/<platform>-<arch>` are untested against a real `dist`.
- Large-database behaviour (the user's 16GB userdata) is unmeasured; H1/H2 are reasoned from query shape, not timed.
- Two-client engagement, disconnect/reconnect and stale-event behaviour exist as unit tests, not as a real two-socket run.
- No workflow execution for the split release workflow; YAML parse and input/matrix assertions only.

## Acceptance matrix mapping

| ID  | Status                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Architecture met; liveness blocked by C1/C2/H1 until fixed                                                                         |
| A2  | Bounded and ordered on the wire; C2 coalescing and H2 paging missing                                                               |
| A3  | Durable ledger, identity and fencing met; H4 receiver timeout and M2 stale backoff outstanding; real-process lost-ACK test missing |
| A4  | Met in source and backfill; qualification on large DB outstanding                                                                  |
| A5  | Met (provider, subagent, terminal, hidden shell, delegation/watch, unknown protects)                                               |
| A6  | Met                                                                                                                                |
| A7  | Met (all sections, same-section renewal, no inactive forced return)                                                                |
| A8  | Met                                                                                                                                |
| A9  | Met                                                                                                                                |
| A10 | Met                                                                                                                                |
| A11 | Met; propagation lag note in L2                                                                                                    |
| A12 | Met                                                                                                                                |
| A13 | Partially met: grouping/newest-first fine; M4 frontier and M5 manual confirmation path wrong                                       |
| A14 | Met; M8 banner edge cases                                                                                                          |
| A15 | Met for missing binary and child death; H3 makes "paused" too easy to reach and permanent                                          |
| A16 | Packaging wired; no native qualification evidence                                                                                  |
| A17 | Lengths respected in files read; M6/M7 duplicate/dead code outstanding                                                             |

## Fix plan (ordered)

1. **C1** — frontier inside `observe` transaction (or bounded retry); regression test.
2. **C2** — per-thread coalescing set, event-type filter, overflow → full rescan not failure; regression test.
3. **H1** — 15s sweep with bounded per-tick budget, heartbeat on its own fiber, scoped CTE; timing test.
4. **H3** — reclassify sleep/wake, disappearance and overflow as resync; add paused recovery on settings change.
5. **H4** — ack frame on enqueue, outcome via receipt, 30s unsettled bound; delayed-command test.
6. **H2** — paged capture transactions and capture budget; concurrent-move test.
7. **M2/M3/M9** — Rust per-thread stale backoff, pre-ready budget alignment, decision pass rate limit.
8. **M4/M5** — sequence frontier for notifications; manual confirmation from own command outcome; Undo marker.
9. **M1** — policy frame + `update_policy` instead of resnapshot.
10. **M6/M7/M8/L1/L2** — cleanup and polish.
11. Re-run the scoped organiser/runtime/reactor suites, Rust crate fmt/clippy/tests, configured server/web/contracts typechecks; then request the native/packaged qualification matrix before any production or release claim.

No commit, push, broad validation, live userdata or provider qualification was performed or is authorized by this report.

## Addendum — lifecycle re-review and the resolved-but-idle Needs you decision

### Lifecycle fix re-reviewed

The saved `organizationLifecycle.ts` now exempts `OrganizationResync` from the 3-in-30s budget with 200ms pacing, and `organizationLifecycle.test.ts` covers four expected resyncs followed by three real failures with scopes closed. That resolves the self-reported defect. Independent concerns that remain:

- Only two bridge sites raise `OrganizationResync` (`organizationBridge.ts:319,327`). The frontier race (`:213`, C1), thread disappearance (`:222`), observation-queue and capture overflow (`:77,251`), clock discontinuity (`:331`) and the pre-ready heartbeat budget (`:313`, M3) still raise plain `Error` and consume the budget. H3 stands with those exact lines.
- Resync pacing has no cap. A flapping barrier (several Undos in a row, or settings sliders being dragged) produces back-to-back full resnapshots every 200ms plus capture time. Recommend a minimum resync spacing of 2s, coalescing changes that arrive during capture, and never starting a resync while a proposal is in flight (finish or fence the receipt first).
- Paused remains permanent until server restart (`Effect.never`). A settings change, a successful manual move or an explicit retry should clear `attempts`, otherwise the agreed "Restart as recovery hatch, not substitute" is violated.

### D1 — Resolved request in Needs you while work is idle

**Observed behaviour.** `scheduler.rs:206-212`: once `actionable` clears, the only reaction out of Needs you is `Work::Active → Present`. An idle thread whose request was answered stays in Needs you indefinitely. Cleanup never touches Needs you (`scheduler.rs:144-148`, `organizationProposal.validation.ts:90` allow only Present/Later), so such threads accumulate forever and the section stops being truthful.

**Agreements.** "Needs you takes precedence while actionable requests remain" and the first agreement "once resolved, Present unless another request remains" describe automatic attention placement. "No forced return if neither active nor actionable" is the manual-override expiry rule: it protects a section the **user** chose. Automatic Needs you placement is not a user choice, so keeping an idle, answered thread there is not protected by that rule.

**Decision (no user clarification needed).**

1. Automatically placed Needs you (the row's `latest_automatic_move_id` is set; the canonical hook already clears it on every deliberate move, `organizationFacts.events.ts:92`): when no actionable request remains, no manual override is live and no snooze is set, move to Present **regardless of work state** (idle, active or unknown; returning to Present is not cleanup, so unknown does not need protection). Grant the shared grace on this return so target/idle cannot evict it immediately.
2. Manually placed Needs you (no `latest_automatic_move_id`): unchanged. Honour the fixed override; at expiry Needs you if actionable, Present if active, otherwise keep.
3. Snooze-expired placement: unchanged. The reminder keeps the row actionable until a human message, response or deliberate move, so it is not affected by rule 1.
4. Optional but recommended for fairness: let the older rule consider non-actionable Needs you rows (extend the allow-lists at `scheduler.rs:144-148` and `organizationProposal.validation.ts:90`), so a stale manual reminder eventually ages to Done like any other section. If the integration owner prefers the legacy Present/Later-only reading, record that choice; rule 1 is required either way.

**Implementation.**

- `protocol/thread-organization/facts.proto`: add `optional bool automatic_placement = 17` to `ThreadFacts`; `admission_wire.rs` row schema `(Row, 2..=10 | 12..=17)`; TS encode/decode row field 17; shared hex fixtures regenerated.
- `organizationFacts.query.ts`: select `runtime.latest_automatic_move_id`; `organizationFacts.build.ts`: `automaticPlacement: raw.latestAutomaticMoveId !== null` (include in the digest so it refreshes when the hook clears it).
- `scheduling.proto`: `REASON_RESOLVED = 7`; `organizationProposal.wire.ts` reasons array and the `ThreadOrganizationNativeReason` contract gain `"resolved"`.
- `scheduler.rs` `reaction`: after the `actionable` branch, `if row.section == NeedsYou && row.automatic_placement == Some(true) { Present, Resolved }`; keep the `Work::Active` branch for other sections.
- `organizationProposal.validation.ts`: `resolved` requires `from === "needs-you"`, `destination === "present"`, `!row.actionable`, `!snoozed`, `!manual`, `row.automaticPlacement === true`, `inactivityCutoffMs === null`.
- `organizationAcceptance.ts`: map `resolved` to event `reason: "move", source: "automatic"` with `automaticMove.reason: "resolved"`; `organizationFacts.events.ts:74-77`: grant grace when `updated.automaticMove?.reason === "resolved"` as well as on deliberate returns to Present.
- Notifications: the automatic group toast ("Moved to Present", Undo) already covers it; Undo restores to Needs you, which the Undo validator permits.

**Tests.** Rust scheduler: automatic Needs you + idle + resolved → Present; manual Needs you + idle → no reaction; snooze reminder → no reaction. TS validation for the new reason. Engine: approval requested → Needs you → approval resolved while idle → Present with grace and a single automatic event; Undo returns it to Needs you. Browser: toast shows "Moved to Present" with Undo.
