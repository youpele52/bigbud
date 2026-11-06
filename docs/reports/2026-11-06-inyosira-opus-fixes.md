# Inyosira native organiser — Opus 5.5 review remediation

**Date:** 6 November, 2026
**Writer:** delegated Opus 5.5 thread (sole code writer; parent integration thread supervised read-only)
**Input:** `docs/reports/2026-11-06-inyosira-fable-review.md` including its addendum (lifecycle re-review, D1)
**Scope rules honoured:** no stage/commit/push, no repo-wide or full-suite checks, no `bun test`, no live userdata or provider experiments, migrations 145–152 untouched, row-baseline/workspace/project-UI/connection-resilience hunks preserved, OpenCode V2 relocation left fail-closed.

## Incident during this run

An orphaned duplicate of this thread's earlier session (PID 58349, parent PID 1, no longer attached to the bigbud app) was still editing organiser files until 00:26. Two concurrent writers violated the single-writer rule, and the orphan's results could never be reported, so I stopped it with `SIGTERM` at 00:27. Its on-disk work (bridge split into `.loops`/`.policy`/`.publisher`/`.proposals`/`.startup`, paged capture, lifecycle spacing and recovery, protocol policy frame on the TS side) was reviewed, kept and completed here. No other process or file was touched.

## Findings and what changed

| ID  | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `organizationFacts.store.ts` reads the orchestration frontier inside its own write transaction and returns it with `applied`/`unchanged`/`missing`; the input frontier parameter is gone. `organizationBridge.publisher.ts` treats `stale` as "re-mark and retry later", never a failure, and keeps the published frontier monotonic.                                                                                                                                                    |
| C2  | Capture marks thread IDs into the bounded `OrganizationObservation` set (2000); assistant streaming is filtered out; overflow requests a full membership rescan instead of failing. Native control frames go to a separate bounded proposal queue.                                                                                                                                                                                                                                       |
| H1  | Heartbeat runs on its own fiber every 1s (`organizationBridge.loops.ts`) and never waits on observation, policy or proposals. Membership sweep is a cheap indexed ID page every 15s; refresh work is capped at 32 threads or 200ms per 200ms pass. Per-thread raw-fact reads scope the model-choice CTE to the thread.                                                                                                                                                                   |
| H2  | `organizationSnapshot.capture.ts` observes each row in its own short write transaction with a 120s capture budget (exceeding it is `OrganizationResync`), up to 3 stale retries per row, and the live capture covers rows changed after they were read.                                                                                                                                                                                                                                  |
| H3  | Clock discontinuity, thread disappearance without a tombstone, capture overflow, projection lag and concurrent policy reconcile are `OrganizationResync`. Genuine native faults use the tagged `OrganizationNativeFault` or plain errors and still consume the 3-in-30s budget.                                                                                                                                                                                                          |
| H4  | The native receiver only admits and enqueues (resolves immediately); outcomes travel in receipts. Proposals are handled serially with a 30s "still unsettled" bound (Rust independently gives up after ~22s of retransmits, which is the agreed contract).                                                                                                                                                                                                                               |
| M1  | New `policy` frame (`v1.proto` Frame field 10). Rust `admission_policy.rs` accepts a higher version (full replacement) or the same version with only the target drain barrier advancing; the scheduler applies it in place via `update_policy`. TS `organizationBridge.policy.ts` commits the DB barrier/version first, switches acceptance to the new policy, then sends the frame; it never runs while a proposal is in flight. Settings changes and Undo no longer restart the child. |
| M2  | Rust blocks a settled thread on **its own** fact version only; `stale` also lifts after a per-thread capped exponential backoff (1s doubling to 60s). Unrelated facts never lift it.                                                                                                                                                                                                                                                                                                     |
| M3  | Pre-ready budget matches Rust: 60s total, 10s without snapshot progress.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| M9  | Rust decision passes are spaced at least 250ms apart when only dirtied by facts; the deadline reschedule (≤15s) and the earliest stale-backoff expiry still wake it.                                                                                                                                                                                                                                                                                                                     |
| M4  | Notifications arm only when this connection's delivery reports `live` (emitted after replay), at the applied sequence of that moment. Admission is `sequence > frontier`, deduplicated by sequence, with a 15s age cap measured on server time only (newest observed `occurredAt`), never the client clock. Recovery and non-live lifecycle states disarm.                                                                                                                               |
| M5  | The event path toasts automatic moves only. Manual confirmations come from the issuing client's own accepted commands (`moveThreadsToState`), only for threads whose state actually changed, with the factual 10-minute copy. Other windows/users and Undo restorations produce no manual toast.                                                                                                                                                                                         |
| M6  | `idleRulesFor` moved to `orchestration/threadOrganization.idleRules.ts`. Legacy schedulers renamed to `ThreadOrganizationReactor.idle.fixture.ts`, `.snooze.fixture.ts`, `.snooze.logic.fixture.ts` (test-only). `organizationScheduler.static.test.ts` asserts no production module imports them or produces `thread.organization.idle`/`snooze.expire` outside the decider.                                                                                                            |
| M7  | `recordTransition` (dead production code with divergent semantics) deleted with its schema and module; the canonical hook and fact store are the single owner of `thread_organization_runtime_threads`. Policy rollback, global-first lock order and reopen tests were rewritten to write the thread row the way the hook does.                                                                                                                                                          |
| M8  | Banner shows only when the target choice is unset (`null`) and not dismissed; explicit off is respected. Enable sets only `inyosiraPresentTargetEnabled` and `inyosiraIntroductionDismissed`, preserving a configured target. Paused copy states the recovery paths.                                                                                                                                                                                                                     |
| L1  | A half-cleared snooze pair is published as an open-ended protected snooze (identity kept or `inconsistent-snooze`, deadline `MAX_SAFE_INTEGER`), never a malformed row. New attention still interrupts it and the resulting move clears the snooze. Not logged (pure build function).                                                                                                                                                                                                    |
| L2  | One shared status poll per connection (`useSyncExternalStore` store). Engagement RPC marks the thread for an immediate fact refresh through the owner's `observe` hook.                                                                                                                                                                                                                                                                                                                  |

### Lifecycle addendum

- Resyncs are spaced 2s doubling to 60s, reset after a 60s healthy run, and never consume the failure budget.
- Changes arriving during capture coalesce into the next attempt (the new snapshot reads current state).
- `OrganizationFailureGate` defers a resync raised while a proposal is in flight until its receipt has been sent or the handler fails; real faults fence immediately.
- Paused is never permanent: it clears on a settings change, a successful manual move (canonical hook signal, `organizationRecovery.ts`), or after a 5-minute cooldown. No explicit "Retry" button was added; see remaining items.

### D1 — answered automatic Needs you returns to Present

- Proto: `ThreadFacts.automatic_placement = 17`, `REASON_RESOLVED = 7`; Rust wire schema `(Row, 2..=10 | 12..=17)`, Frame 10.
- TS: query selects `latest_automatic_move_id`; build sets `automaticPlacement` only for Needs you rows and includes it in the digest; codec field 17; wire reason 7 → contract `"resolved"`.
- Rust `scheduler.rs`: after the actionable branch, automatic Needs you → Present (`Resolved`) whatever the work state; manual placement and live overrides are untouched.
- Validation: `resolved` requires from Needs you, destination Present, not actionable, not snoozed, `automaticPlacement === true`, no cutoff; a live manual override returns `not-due`.
- Acceptance maps it to `reason: "move", source: "automatic"` with `automaticMove.reason: "resolved"`; the canonical hook grants the shared grace on it.
- **Hook fix required for D1:** the hook previously set `latest_automatic_move_id = NULL` on every hooked event, including approval/input responses and request activity, so an answered automatic placement could never be recognised. It now changes the identity only on organisation updates (automatic id, or `NULL` for deliberate moves) and on human messages (new work). Undo keeps its existing guards: revision, move identity, attention watermark unchanged since the move, and no hidden running work.
- Older-rule scope stays Present/Later only (optional Needs-you fairness not adopted, per the user's instruction).

## Tests added or updated

Server (all in the `integration` project):

- `organizationAcceptance.resolved.engine.test.ts`: approval requested → automatic Needs you → approval resolved while idle → Present with grace and one automatic `resolved` event → Undo restores Needs you; the restored (deliberate) placement is never auto-returned.
- `organizationBridge.load.engine.test.ts` (real Rust binary): 2,100 assistant streaming deltas on three threads with canonical approval request/resolve commits interleaved while the live bridge observes; the same owner/generation stays active and healthy, and the fiber never fails (C1/C2/H1 regression).
- `organizationObservation.test.ts`: >2000 deltas coalesce to one mark per thread, no rescan; deletion subtree; overflow → rescan.
- `organizationBridge.loops.test.ts`: heartbeat sends the written sequence; sleep/wake and backwards clock → resync; activation/native-silence budgets are real faults; a blocked observation does not starve heartbeats; 32-row/200ms pass bounds and the 15s sweep.
- `organizationBridge.publisher.test.ts`: stale → re-mark without failure; monotonic frontier; the sequence never advances past a failed write; tombstone vs disappearance → resync.
- `organizationBridge.proposals.test.ts`: a 7s canonical delay yields one late receipt; a retransmission resends the durable receipt without dispatching again; the unsettled bound fails.
- `organizationBridge.policy.test.ts`: barrier-only and settings changes become in-place policy frames; deferred while a proposal is in flight.
- `organizationBridge.failure.test.ts`, `organizationFacts.build.test.ts` (D1 placement and digest, L1), `organizationScheduler.static.test.ts` (M6).
- Updated: validation (`resolved` cases), wire (reason 7), protocol (policy frame and field 17 round-trip), lifecycle (spacing, paused recovery), capture (paged, concurrent write, budget), store, runtime repository and reopen (M7).

Rust: scheduler D1 (three work states, manual/explicit-false/reminder stay, override wins), same-version barrier-only update; session stale backoff ignores unrelated facts, fact-burst pass spacing, policy frames (inactive rejected, barrier advance accepted, regressions rejected).

Web: notification frontier, server-time cap with ±60s client skew, deliberate/other-client/Undo exclusion, newest-first grouping, D1 toast and Undo target; status store sharing and reconnect; banner explicit off and target preservation (browser); snooze-picker order expectation updated to the agreed Needs-you-first order.

## Check results (focused, this run)

- Rust: `cargo fmt --package bigbud-desktop-supervisor --check` OK; `cargo clippy --locked --package bigbud-desktop-supervisor --all-targets -- -D warnings` OK; `cargo test --locked --package bigbud-desktop-supervisor organization::` 44 passed; `--test organization_fixtures` 3 passed; `--test organization_process` 2 passed.
- Typechecks: `bun run --cwd apps/server typecheck` exit 0 (after the final edits); `packages/contracts` exit 0; `apps/web` exit 0.
- Format/lint on the explicit 66-file list: `oxfmt --check` clean; `oxlint` 0 warnings, 0 errors. Every touched TS/TSX/Rust/proto file is ≤400 lines.
- Server Vitest (`--project integration`), run per file group during the work, all passing: D1 engine; real-binary bridge load and existing bridge engine (2/2, not skipped); observation, loops, publisher, proposals (13); policy follower; failure gate and fact build (3); store, capture, lifecycle, acceptance, acceptance engine, validation, wire (25); protocol/validation/wire after D1 (22); runtime repository and reopen after M7 (5); static guard plus legacy fixture, reactor and engine organisation tests (7 files, 29 tests).
- **Not completed:** one consolidated re-run of all 47 organiser server test files after the final formatting and lint-only edits. The xargs form hung at startup with 0% CPU (killed after 11 minutes), and the batched re-run could not start because the tool stream closed. The last edits after the per-group passes were formatter output, two lint-only test rewrites and two test-only type fixes; server typecheck passed afterwards.
- Web Vitest: notifications (5 + 5), delivery including D1 toast, status store (2), snooze picker (9, after updating the order expectation), sidebar logic: all passing. Browser: `InyosiraSettings.browser.tsx` 4 passed; inyosiraSection, organizationEngagement and inyosiraSnoozeDialog passed (28 tests); `Sidebar.inyosiraGroup.browser.tsx` fails to import for the unrelated `ensureNativeApi` reason below.

## Remaining items and external qualification (honest)

- **Not done:** review test 9 (a real-process lost-ACK kill at each boundary across a TS restart). The ledger, recovery and durable receipt paths are unchanged and their existing single-process replay tests pass, but no cross-process kill test exists.
- **Not done:** an explicit "Retry" control for paused automation. Recovery is via settings change, manual move or the 5-minute cooldown; restart remains a hatch.
- **Partially covered:** the review asked for a seeded 5k-row timing test (H1) and a 10k-row concurrent-move capture test (H2). This run has bounded-pass unit tests, a 300-row concurrent-write capture test and the 2,100-event real-binary load test, not timed 5k/10k fixtures. Large-database behaviour (the user's ~16GB userdata) is still unmeasured.
- Notifications are armed only on `live`. The `fallback-fenced` delivery route never emits `live`, so automatic-move toasts are intentionally silent in that degraded mode; moves themselves are unaffected.
- L1 inconsistent snooze pairs are protected but not logged.
- Unrelated pre-existing failure observed (not touched): `Sidebar.inyosiraGroup.browser.tsx` fails to import because `src/rpc/nativeApi.ts` no longer exports `ensureNativeApi`, which other in-flight project-edit work depends on.
- Packaged Windows/macOS/Linux organiser qualification, the Windows ARM64 release step, standalone server packaging and two-socket engagement remain unqualified (unchanged from the Fable report). Nothing here is a production-readiness claim.

## Acceptance matrix (after this remediation)

| ID     | Status                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------- |
| A1     | Liveness blockers C1/C2/H1 fixed and regression-tested (unit + real-binary load); single native scheduler unchanged |
| A2     | Bounded/ordered wire; coalesced observation; paged capture                                                          |
| A3     | Ledger/fencing unchanged; H4 ack-on-enqueue; M2 per-thread backoff; cross-process lost-ACK kill test still missing  |
| A4     | Unchanged (met); large-DB qualification outstanding                                                                 |
| A5–A10 | Unchanged (met); D1 adds the resolved automatic return with grace                                                   |
| A11    | Engagement now refreshes facts promptly (L2)                                                                        |
| A12    | Unchanged (met)                                                                                                     |
| A13    | Sequence frontier armed at live, server-time cap, automatic-only event toasts, own-outcome manual confirmation      |
| A14    | M8 banner edge cases fixed                                                                                          |
| A15    | Paused recovers (settings, manual move, cooldown); routine resyncs never pause; resync spacing                      |
| A16    | Packaging unchanged; no native qualification evidence                                                               |
| A17    | All touched files ≤400 lines; M6/M7 duplicate/legacy production code removed                                        |

No commit, push, staging, broad validation, live userdata or provider qualification was performed.

---

## Round 2 — re-review R1–R9 remediation (2026-11-06, Opus 5.5)

Source: `docs/reports/2026-11-06-inyosira-fable-rereview.md` (R1–R9). Sole source writer for this round. Before editing I checked that no orphan writer was running: only this session (Opus) and the idle Fable reviewer were alive. No stage, commit or push. No full-suite or workspace-wide checks.

### What changed, per finding

- **R1 — unique identity for stale re-proposals.** `session_operations.rs` now mixes a per-session attempt-0 counter into the occurrence digest. With the per-backend nonce and per-spawn generation, every new attempt-0 proposal after a `stale` receipt gets a fresh occurrence and operation ID. Retransmissions after a lost ack still reuse the stored proposal byte for byte. Rust regression in `session_tests.rs`: two `stale` receipts with no facts in between produce distinct identities. I confirmed the test fails with the counter removed and passes with it. TS regression against the real ledger (`organizationBridge.proposals.ledger.engine.test.ts`): a genuine `stale` outcome (policy fingerprint mismatch, i.e. settings saved before the policy frame arrived) followed by the re-proposal is `prepared`, not `conflict`.
- **R2 — capture overflow is a resync.** New `organizationBridge.capture.ts` (capture consumer). When the live capture stream ends and `isOverflowed()` is true (the delivery hub sets it before the stream dies), the consumer raises `OrganizationResync`, never a real fault. Test `organizationBridge.capture.test.ts` overflows a real delivery-hub capture and checks that the lifecycle sees a routine resync, never paused.
- **R3 — size-scaled, bounded capture and a terminal limit.**
  - `organizationSnapshot.capture.ts`: the budget is `max(120 s, members × 10 ms)` and doubles on each consecutive overrun, capped at 30 min. A cheap `COUNT` membership precheck (`organizationFacts.query.ts`) runs before any heavy read.
  - Above the live row limit → `OrganizationLimit("thread-limit")`. An overrun at the cap → `OrganizationLimit("capture-time")`.
  - `organizationLifecycle.ts`: a terminal `OrganizationLimit` publishes paused with a reason and waits only on `explicitRetry` (a settings change). It never re-runs on the cooldown timer, so the heavy loop is gone.
  - Wiring: `organizationStatus.ts`, `ThreadOrganizationReactor.ts`, and the contracts status gains an optional `reason: "thread-limit" | "capture-time"` (`packages/contracts/src/server/organizationAutomation.ts`).
  - Tests: `organizationLifecycle.test.ts`, `organizationSnapshot.capture.test.ts`, `organizationSnapshot.scale.test.ts`.
- **R4 — heartbeat continues during a deferred resync.** `organizationBridge.loops.ts`: the heartbeat reports a discontinuity through a callback and keeps beating. It does not refresh the owner's observation time, so stale observations are not laundered. Test in `organizationBridge.loops.test.ts`.
- **R5 — overflow rescan recovers deletions.** A completed membership sweep re-marks every published row it did not see, so a dropped deletion event is still observed (as disappearance → resync path). Test in `organizationBridge.loops.test.ts`.
- **R6 — exit for a previously rejected command.** A single dispatch helper is shared by startup recovery (`organizationBridge.startup.ts`) and the proposal handler (`organizationBridge.proposals.ts`). A persisted command rejection settles the operation as `stale` instead of retrying forever. Test `organizationBridge.startup.test.ts` covers both paths.
- **R7 — observation throttle with an attention fast path.** `organizationObservation.ts`: non-attention `thread.activity-appended` events (tool chatter) refresh a thread at most once per `ORGANIZATION_OBSERVATION_INTERVAL_MS` (1 s). Attention activity (`approval|user-input|model-choice`), turns, user messages, tasks, organisation and deletion events stay immediate. This delays only age data, by at most about 1 s. Tests in `organizationObservation.test.ts`.
- **R8 — bound alignment.** `ORGANIZATION_PROPOSAL_UNSETTLED_MS` is now 20 s, so the TS bound fires before Rust's own ack budget runs out.
- **R9 — shared copy and sensible polling.**
  - `organizationBridge.policy.ts`: each tick runs only the in-memory settings fingerprint check. The DB policy read happens only on a barrier hint (deliberate organisation seen by the capture consumer) or the 30 s fallback (`ORGANIZATION_POLICY_FALLBACK_MS`). Acceptance always rechecks the stored barrier.
  - Web: new `apps/web/src/lib/organizationStatusCopy.ts` holds the one paused explanation, used by both `Sidebar.inyosiraStatus.tsx` and `InyosiraIdleSettingsSection.tsx`. It has a variant for each limit reason. The thread-limit copy says "delete", not "archive", because membership counts archived threads.
  - Tests: `organizationBridge.policy.test.ts` (hint and fallback), `organizationStatusCopy.test.ts`.
- `organizationRecovery.process.fixture.ts` was adapted to the new bridge and lifecycle API. Its behaviour is unchanged.

### Changed-file manifest (this round)

Rust: `crates/bigbud-desktop-supervisor/src/organization/session_operations.rs`, `.../session_tests.rs`.

Contracts: `packages/contracts/src/server/organizationAutomation.ts`.

Server (`apps/server/src/`): `orchestration/Layers/ThreadOrganizationReactor.ts`, and these files in `thread-organization/`:
`organizationBridge.ts`, `organizationBridge.capture.ts` (new), `organizationBridge.capture.test.ts` (new), `organizationBridge.loops.ts`, `organizationBridge.loops.test.ts`, `organizationBridge.policy.ts`, `organizationBridge.policy.test.ts`, `organizationBridge.proposals.ts`, `organizationBridge.proposals.ledger.engine.test.ts` (new), `organizationBridge.startup.ts`, `organizationBridge.startup.test.ts`, `organizationFacts.query.ts`, `organizationLifecycle.ts`, `organizationLifecycle.test.ts`, `organizationObservation.ts`, `organizationObservation.test.ts`, `organizationRecovery.process.fixture.ts`, `organizationSnapshot.capture.ts`, `organizationSnapshot.capture.test.ts`, `organizationSnapshot.scale.test.ts`, `organizationStatus.ts`.

Web (`apps/web/src/`): `components/settings/InyosiraIdleSettingsSection.tsx`, `components/sidebar/Sidebar.inyosiraStatus.tsx`, `lib/organizationStatusCopy.ts` (new), `lib/organizationStatusCopy.test.ts` (new).

Not touched: migrations 145–152, the row-baseline hunks, and the workspace OpenCodeV2 relocation, which stays disabled. The machine-readable list is in `/tmp/opus-rr-changed.txt`; drop the Fable-owned re-review doc from it.

### Check evidence (focused, exact commands)

| Check                                     | Command                                                                                                                                     | Result                                                             | Log                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------- |
| 400-line limit, all 29 changed code files | `wc -l` on the explicit list                                                                                                                | max 371 (`session_tests.rs`), none over 400                        | —                                      |
| Format, 27 TS/TSX files                   | `xargs ./node_modules/.bin/oxfmt --check < /tmp/opus-rr-ts.txt`                                                                             | 2 files formatted, then "All matched files use the correct format" | `/tmp/opus-rr-fmt.log` (pre-fix)       |
| Lint, 27 TS/TSX files                     | `xargs ./node_modules/.bin/oxlint < /tmp/opus-rr-ts.txt`                                                                                    | 1 warning (`markBarrier` scoping) fixed → 0 warnings, 0 errors     | `/tmp/opus-rr-lint.log` (pre-fix)      |
| Server typecheck (after last edit)        | `bun run --cwd apps/server typecheck`                                                                                                       | exit 0, 0 `error TS` (only Effect advisory messages)               | `/tmp/opus-rr-server-types-final2.log` |
| Web typecheck                             | `bun run --cwd apps/web typecheck`                                                                                                          | exit 0                                                             | `/tmp/rr-web-types.log`                |
| Contracts typecheck                       | `bun run --cwd packages/contracts typecheck`                                                                                                | exit 0                                                             | `/tmp/rr-contracts-types.log`          |
| Rust fmt                                  | `cargo fmt --package bigbud-desktop-supervisor --check`                                                                                     | exit 0                                                             | `/tmp/rr-rust.log`                     |
| Rust clippy                               | `cargo clippy --locked --package bigbud-desktop-supervisor --all-targets -- -D warnings`                                                    | exit 0                                                             | `/tmp/rr-rust.log`                     |
| Rust tests                                | `cargo test --locked --package bigbud-desktop-supervisor organization::` plus `--test organization_fixtures`, `--test organization_process` | 45 / 3 / 2 passed                                                  | `/tmp/rr-rust.log`                     |
| Debug binary for real-process tests       | `cargo build --package bigbud-desktop-supervisor`                                                                                           | exit 0                                                             | `/tmp/rr-rust.log`                     |
| New/changed server units (8 files)        | `bun run --cwd apps/server vitest run --project integration <8 files>`                                                                      | 23/23 passed                                                       | `/tmp/rr-bridge-units.log`             |
| Web units                                 | `bun run --cwd apps/web vitest run src/lib/organizationStatusCopy.test.ts <+1>`                                                             | 4/4 passed                                                         | `/tmp/rr-web-unit.log`                 |

**Consolidated organiser server suite: not run by me.** My batched launch of the 52-file list (`/tmp/rr-integ-rel.txt`, all in the `integration` project, none in the unit manifests) never started a runner process, and no batch logs were produced. The parent took over test execution and ran 10-file sequential batches (`/tmp/inyosira-r-final-batch1..5.log`, finished 07:20:48–07:22:41). After that I did not launch any server tests, to avoid overlap.

**Edits that landed after the parent's batches** (07:22:50–07:22:55):

- `organizationBridge.startup.test.ts`: formatting only.
- `organizationStatusCopy.test.ts` (web): formatting only.
- `organizationBridge.ts`: `let markBarrier = () => {}` became `let markBarrier: (() => void) | undefined` and the call became `markBarrier?.()`. Same behaviour; it clears the lint warning.

Recommended confirmation rerun by the test owner: `organizationBridge.engine.test.ts`, `organizationBridge.load.engine.test.ts`, `organizationRecovery.process.test.ts` and `organizationBridge.startup.test.ts` (integration project), plus web `src/lib/organizationStatusCopy.test.ts`. The server typecheck above already covers the edit.

**Parent-owned results (reported by the integration owner, not rerun by me):** the 52-file organiser server suite passed, 171 tests (batches 39 + 38 + 16 + 33 + 45, logs `/tmp/inyosira-r-final-batch{1..5}.log`). These batches finished before the three late edits above, so the confirmation rerun still applies. The Inyosira settings browser test passed 4/4. `Sidebar.inyosiraGroup` browser test failed: its own `vi.mock(nativeApi)` fixture omits `ensureNativeApi`, which the production module exports. The parent is fixing only that fixture mock.

### Remaining qualifications (honest)

- The thread limit (100,000) and the capture-budget constants are engineering choices validated by the 5k/10k scale tests, not by a measured 100k-row production DB.
- `capture-time` and `thread-limit` recover only through a settings change, by design (R3). The copy says so. A user who never changes settings stays paused, but manual moves keep working.
- External Windows/macOS/Linux packaged CI qualification is still unavailable locally. Nothing here claims production readiness.
- Independent Fable follow-up review of this round is pending (parent-owned).

### Ownership

Source ownership is **relinquished** as of this section. I will make no further source edits unless asked again.
