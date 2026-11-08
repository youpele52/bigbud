# Keep threads with terminal work out of automatic idle moves

**Date:** 5 November, 2026
**Status:** Implemented — focused automated validation complete; live harness/UI and cross-platform qualification not performed
**Owner:** Terminal idle-protection implementer, coordinated with the older-thread wall-clock aging owner

## Summary

A thread in Present must not automatically move to Later or Done while one of its terminals is running work, including quiet OpenCode or Pi sessions. Reuse server-owned terminal tracking, independent of drawer visibility, UI focus, terminal output, or client connection. Once terminal work finishes, allow a full configured idle window before automatic movement resumes. An unused shell alone does not keep a thread active.

## Independent commit composition

The terminal feature is isolated against the existing HEAD policy: it does not include concurrent managed-workspace, settled-turn-control eligibility, or older-thread wall-clock aging changes. References below to the separately authorized wall-clock policy describe compatibility, not production changes shipped by this feature. Terminal sweeper tests first establish eligibility with no candidates for a full configured startup window, then exercise terminal protection; they therefore work with either older-rule startup policy. Explicit policy-change grace and paging-reset assertions remain independent. The combined working-tree validation below is historical; isolated-index validation is reported separately during commit preparation.

## Review remediation

- Bind the shared terminal layer directly at production engine construction, including the cleanup-first construction path; composition regressions cover both consumer orders and one memoized terminal owner.
- Scope terminal-veto retries/exclusions to the rule that rejected the quiet window. Keep dispatch attempts shared by revision so an accepted older-rule move cannot race a duplicate short-rule move.
- Derive legacy command cutoffs only from enabled matching rules.
- Refresh only the affected thread on queries, non-output events, inspection failures, and close. Cache session membership by map version; shared polling alone performs global reconciliation and retained-barrier pruning.
- Forget barriers for every finalized deletion payload ID as well as the aggregate root, deduplicating IDs and preserving unrelated threads.
- New focused regressions reproduce each finding. Re-review remains required before committing.

### Isolated-index validation after remediation

Exported only the terminal-owned staged composition onto HEAD with `git checkout-index` into `/tmp/bigbud-terminal-index-q_08h5q6` (not a Git worktree). Linked existing dependencies, redirecting workspace package links to the exported source; also linked `scripts/node_modules`, needed by the configured server typecheck. No external aging, settled-control, managed-workspace, or UI production changes are included.

- Focused Vitest run: **19 files, 75 tests passed**, exit 0. Scope is the 17-file terminal/engine/sweeper/persistence command recorded below plus `src/server.engineTerminal.test.ts` and `src/orchestration/Layers/ThreadOrganizationReactor.test.ts`.
- `bun run --cwd apps/server typecheck`: exit 0.
- `bun run --cwd packages/contracts typecheck`: exit 0.
- Initial isolation test run exposed a retry-boundary alignment mistake in the newly adapted short-rule test; fixed by ending its busy phase on the actual retry boundary, retaining the exact cutoff-equality assertion. The final 75-test run includes the corrected test.
- An initial snapshot typecheck failed because dependency linkage for script imports was incomplete; after linking the existing script dependencies, the configured check passed without changing source or weakening types.

## Related Work

- Source: user request in thread `3fe44116-b3c7-4b72-bb22-af9fdd78c5fe`.
- [Terminal harness identity](2026-09-23-terminal-harness-icon-plan.md): existing process detection and stale-result safeguards. Its remote-detection limitation is historical; current remote polling inspects remote processes.
- [Confirmed terminal lifecycle](2026-10-29-terminal-confirmed-lifecycle-plan.md) and [review remediation](2026-10-29-terminal-review-remediation-plan.md): preserve generation fencing, uncertain-stop ownership, and non-destructive view disposal.
- Notes and Kanban lookup attempted; both returned `Workspace tools are not ready`. Related records could not be verified. No issue ID or PR supplied.

## Problem

The server persists automatic organization changes based on conversation/provider quiescence without considering terminal work. A terminal can therefore run an interactive harness for longer than the configured idle period while its thread is moved out of Present. Output-based keepalives would not fix silent programs and would unnecessarily couple organization to terminal rendering.

## Goals

- Protect all panes belonging to a thread; one busy pane is sufficient.
- Protect quiet recognized harnesses and other detected terminal child programs.
- Keep protection effective while the terminal drawer is hidden, another thread is selected, or its viewport is unmounted.
- Apply protection to both idle movement and the older-thread automatic Done rule.
- After work ends, begin a fresh quiet window using the applicable automatic rule's configured duration.
- Preserve manual organization, snooze, archive, provider activity, and terminal lifecycle behavior.
- Reuse existing polling with bounded in-memory bookkeeping; no output-driven database writes.

## Non-Goals

- Automatically move a manually Later/Done thread back to Present when its terminal starts work.
- Treat every open PTY or shell as active work.
- Add harness hooks, another process scanner, new UI controls, dependency upgrades, or terminal process termination.
- Change retention/deletion eligibility or provider workflow status.
- Guarantee exact foreground detection across every platform or atomically observe a process before the existing poll sees it.

## Current State

- `apps/server/src/orchestration/Layers/ThreadOrganizationReactor.idle.ts:20–26,46–62,110–150`: 15-second sweep, two automatic rules, batches of 50, revision-fenced commands, and startup/policy/long-gap timing barriers. Declined candidates are retried after a minute.
- `apps/server/src/persistence/Layers/ProjectionThreads.idle.ts:22–76`: SQL eligibility uses conversation activity and organization-change time, with provider/pending-work exclusions but no terminal exclusion.
- `apps/server/src/orchestration/deciderThreads.organization.ts:82–109` and `threadOrganization.idle.logic.ts:27–56`: final state/revision/quiescence checks produce a persisted organization event.
- `apps/server/src/orchestration/Layers/OrchestrationEngine.commandProcessing.ts:155–160`: effectful boundary around pure command decision; suitable for a final terminal-fact guard.
- `apps/server/src/terminal/Layers/Manager.types.ts:26,84–87`: existing one-second polling and per-pane `hasRunningSubprocess`, `activeAgent`, and provider identity.
- `apps/server/src/terminal/Layers/Manager.process-drain.poll.ts:12–40,63–105`: polls running sessions independently of renderer subscriptions; local and remote loops are separate.
- `apps/server/src/terminal/Layers/Manager.agentDetection.ts:144–180,218–280`: bounded shared process inspection; POSIX foreground-group recognition and Windows best-effort unambiguous descendant recognition.
- `apps/server/src/terminal/Layers/Manager.shell.ts:227–326`: general subprocess detection means any direct child, including background jobs; some fallback failures currently collapse to false.
- `apps/server/src/terminal/Layers/Manager.process-drain.identity.ts:41–60,83–115`: identity debounce, failure preservation, and PID/epoch/generation/target fences.
- `apps/server/src/terminal/Layers/Manager.process-drain.remote.ts:29–95`: remote process inspection and identity detection, with failure preservation and execution-target fencing. WSL uses existing subprocess activity rather than this identity path.
- `apps/server/src/terminal/Layers/Manager.session.ts:260–264`: existing `hasActiveThread` counts a running shell and is therefore unsuitable for this policy.
- `apps/web/src/components/terminal/TerminalViewport.session.ts:332–350`: unmount disposes view resources, not the server terminal.

## Phases

### Phase 1: Expose terminal work and quiet-time facts

**Scope:** terminal manager service and focused adjacent helper modules. No new OS polling or client subscription.

1. Add a narrowly named, read-only manager query for thread idle eligibility, separate from `hasActiveThread`. Return terminal work state and the latest confirmed work-to-idle time, not only a boolean.
2. Aggregate all thread panes. Positive evidence is an accepted active generic harness identity or detected running subprocess associated with the current runtime. An ordinary running shell with neither signal is idle. Background children deliberately count: conservatively keeping a thread visible is preferable to hiding running work.
3. Maintain thread-level quiet-time bookkeeping from existing accepted poll/lifecycle transitions. The last busy pane becoming idle starts the quiet window. Confirmed exit/close must release protection and retain the end-time barrier; closing one of several busy panes must not do so. Restart must not create a momentary eligible gap.
4. Preserve positive evidence during inspection failure and unresolved shutdown/reconnect. Do not equate transport loss with process exit. Audit false-on-error subprocess fallbacks so an unknown observation cannot erase known work.
5. Represent initial/uncertain detection explicitly. A running but not yet assessed pane temporarily vetoes automatic moves until assessed; an idle shell with a successful no-work observation does not. Reuse bounded detection attempts and existing failure handling; do not spin or create per-command process scans. Persistent uncertainty may conservatively retain a thread and must remain distinguishable from confirmed busy state in diagnostics/tests.
6. Bound bookkeeping to managed threads and required quiet-window entries; remove deleted-thread state. Do not continuously refresh conversation timestamps or append organization events.

**Exit:** focused manager tests demonstrate busy, idle, unknown, multiple-pane, generation, failure, and completion semantics. Existing terminal lifecycle safeguards are unchanged.

### Phase 2: Guard automatic organization changes

**Depends on:** Phase 1's accepted snapshot and completion semantics.

1. Inject the terminal manager's read-only facts into automatic organization processing using existing service conventions.
2. In the sweeper, skip candidates with busy/unknown terminal work or an unexpired terminal quiet window. Compare against the same captured rule cutoff; the effective last activity is the later of existing organization/conversation activity and terminal-work completion.
3. Recheck the latest facts immediately before deciding `thread.organization.idle` at the serialized command-processing boundary. Keep OS inspection out of the pure decider. A blocked request must use normal no-op command receipt handling, not produce a false organization event.
4. Apply the guard to both automatic rules. A manually placed Later thread with running work must also be protected from automatic Done; do not automatically promote it to Present.
5. Preserve revision fences, policy-change grace, retries, and explicit user operations. Preserve startup/long-gap barriers for the short idle rule. **Coordinated implementation update:** separately owned, user-confirmed older-thread Done aging uses persisted wall-clock inactivity across startup/sleep instead of requiring uninterrupted server uptime; preserve those production hunks. Terminal busy/unknown protection and the full post-terminal-work quiet window apply independently to both rules. An existing SQL candidate is not permission to bypass the final terminal check.
6. Ensure skipped terminal-active candidates cannot monopolize the 50-row batch. Use bounded paging/exclusion or the existing retry mechanism as appropriate; test that other eligible threads continue moving without an unbounded scan.
7. Keep thread quiet-time barriers valid across sweeper restarts in the same server session. On full server restart, terminal-finish timestamps are not durable: freshly managed terminals require assessment, and the short idle rule retains its startup barrier. The separately owned wall-clock older rule does not gain a new startup barrier from this change; do not claim durable exact terminal-finish timestamps or protection for a remote runtime not yet recovered into manager ownership.

**Exit:** deterministic integration tests show no persisted auto-move during observed terminal work and normal movement after the complete quiet window. Manual movement remains unaffected.

### Phase 3: Focused validation and manual qualification

**Depends on:** Phases 1–2.

- Extend manager identity/activity/lifecycle tests and organization sweeper/engine integration tests.
- Run scoped formatting/lint, affected package typechecks, explicit touched-source/test length checks, and focused Vitest suites. Split materially edited source/test files to remain at or below 400 lines.
- Manually run OpenCode or Pi quietly beyond a shortened configured idle threshold; repeat with the drawer closed and another thread selected. Exit the program and verify a full new idle window before movement.
- Compare macOS, Linux, Windows, remote SSH, and WSL behavior. Record native tests versus fixture coverage accurately; do not claim live cross-platform qualification from synthetic tests.

**Exit:** acceptance criteria have test/manual evidence, limitations are recorded, and the plan status is updated only after implementation.

## Risks And Decision Gates

- **Scope decision:** use both generic harness identity and existing subprocess evidence. Recognized-harness-only protection is smaller but leaves other running commands exposed; PTY-exists protection is too broad. Exact foreground-only semantics would need separate work and are not required here.
- **Background work:** a direct background child intentionally keeps its thread active. Detached/untracked jobs are outside the existing detector's guarantee.
- **Platform precision:** POSIX harness identity is foreground-group based, general activity is direct-child based, Windows identity is best effort, and WSL precision differs. Reuse the strongest existing accepted evidence without inventing universal certainty.
- **Sampled state:** final command rechecking closes queued-command races against observed state, not the interval before the next process poll. Avoid presenting this as atomic process-start admission.
- **Uncertainty:** missing evidence is not proof of idle. Preserve known active state; do not keep a confirmed exited runtime active because of stale identity. Persistent unknown state can retain a thread, but should not trigger new notifications or mutate provider status.
- **Quiet-window growth:** choose one bounded owner for terminal completion barriers; do not duplicate maps in both manager and reactor or discard an entry before every applicable rule can safely age out.
- **Rollback:** remove the terminal-specific guard and ephemeral barriers to restore prior idle policy. No schema migration or terminal restart is required. Existing manual organization events remain intact; no automatic restorative moves should be emitted on deployment or rollback.

## Testing And Validation

Primary existing suites:

- `apps/server/src/orchestration/Layers/ThreadOrganizationReactor.idle.test.ts`
- `apps/server/src/orchestration/Layers/OrchestrationEngine.organizationIdle.test.ts`
- `apps/server/src/terminal/Layers/Manager.agentDetection.test.ts`
- `apps/server/src/terminal/Layers/Manager.agentDetection.generic.test.ts`
- `apps/server/src/terminal/Layers/Manager.agentIdentity.failure.test.ts`
- `apps/server/src/terminal/Layers/Manager.agentIdentity.epoch.test.ts`
- `apps/server/src/terminal/Layers/Manager.process-drain.remote.test.ts`
- `apps/server/src/terminal/Layers/Manager.confirmedLifecycle.races.test.ts`

Required cases:

- Ordinary shell can age out; silent OpenCode/Pi and non-harness commands cannot.
- Any busy split pane protects its thread; another thread is unaffected.
- Hidden/unmounted terminal, no output, and disconnected renderer do not remove protection.
- Successful shell return, confirmed exit, and confirmed close start a full fresh quiet window; remaining busy panes and restart handoffs prevent gaps.
- Failed inspection, initial unknown state, remote reconnect, stale identity/epoch/generation, and failed shutdown follow the defined conservative policy.
- Work starts after candidate selection but before command decision; final check vetoes the move without persisting an idle organization event.
- Both automatic rules respect protection; explicit Later/Done/snooze/archive actions remain honored.
- More than 50 protected candidates do not starve unrelated eligible threads.
- Policy change, server startup, long sleep/wake gaps, deletion cleanup, and quiet-window boundary equality preserve existing timing semantics.

Example focused command:

```sh
bun run --cwd apps/server vitest run src/orchestration/Layers/ThreadOrganizationReactor.idle.test.ts src/orchestration/Layers/OrchestrationEngine.organizationIdle.test.ts
```

Run additional terminal suites explicitly through `bun run --cwd apps/server vitest run <paths>`. Never use `bun test`. Repository-wide checks require separate user approval. Actual implementation checks and limitations follow.

### Implementation outcome — 5 November, 2026

- `terminal/Layers/Manager.idleWork.ts` owns ephemeral thread busy/unknown/idle facts and completion barriers. Existing accepted poll results record assessment for the runtime generation **and epoch**; PID/target/generation/epoch fences remain in the existing acceptance paths. Successful no-work assessment permits a shell to age out. Generic harness identity or direct subprocess evidence—including background jobs—vetoes automatic moves. Failed inspection makes previously idle evidence unknown and does not erase positive work evidence.
- The tracker observes existing non-output lifecycle/identity/activity events, completed poll passes, manager queries, and confirmed close. It does not inspect OS processes, depend on a renderer subscription, or write conversation/organization timestamps. Closing/evicting a pane preserves completion barriers; only the final busy/uncertain pane becoming idle starts the quiet window. Restart/lifecycle/uncertain remote ownership remains conservative.
- Completion barriers have one owner, survive reactor restarts within the same server session, and age out after the longest supported rule (30 days). Thread deletion invokes explicit barrier cleanup. No durable exact completion time is promised after a full server restart.
- `Manager.shell.subprocess.ts` separates subprocess inspection from shell resolution to keep edited files within 400 lines. Dual POSIX fallback failures, truncated fallback snapshots, timeouts, and Windows inspection errors no longer masquerade as confirmed no-work observations. Windows and remote behavior have fixture coverage, not live cross-platform qualification.
- The sweep checks terminal state/quiet time against the captured rule cutoff. Internal idle commands carry optional `terminalIdleCutoff`; `OrchestrationEngine.terminalIdle.ts` rechecks current manager facts immediately before the pure decision. A veto uses normal accepted no-op command receipt handling and emits no organization event. Older internal callers without a cutoff receive a conservative applicable configured wait. Explicit manual commands are not guarded.
- `ThreadOrganizationReactor.idle.paging.ts` maintains independent bounded keyset cursors per rule; policy changes reset only the affected cursor. `ListIdleThreadCandidatesInput.after` uses `(activityAt, threadId)` in the same ordering and effective timestamp expression as SQL eligibility. Each enabled rule reads at most one 50-row page per tick, advances even past protected candidates, and wraps after a short/empty page. This avoids cycling indefinitely behind more than 200 protected rows as retry-only exclusions could. Existing retry exclusions and revision fences remain.
- Existing oversized concerns were split into `Manager.process.eviction.ts`, `Manager.shell.subprocess.ts`, and `OrchestrationEngine.commandAggregate.ts`; no dependencies, schema migration, new monitor, UI controls, or process termination policy were added.
- Concurrent project-workspace implementation hunks in command processing and concurrent older-thread aging/query changes were preserved. The older-rule wall-clock restart/sleep semantics were explicitly confirmed through coordination; terminal changes do not restore the former uninterrupted-uptime requirement.

### Executed scoped validation

1. `bun run --cwd apps/server typecheck` — latest explicit run **exit 0**. Existing Effect advisory `message TS...` diagnostics remain in other modules; no error diagnostics or terminal-module diagnostics in that run. Earlier attempts failed while concurrent project-workspace preparation changes had unresolved `SqlClient`/`ServerConfig` requirements; those failures disappeared in the later shared snapshot, not through unrelated repairs by this implementer.
2. `bun run --cwd packages/contracts typecheck` — **exit 0**.
3. This focused Vitest command passed **6 files / 17 tests**, exit 0:

   ```sh
   bun run --cwd apps/server vitest run \
     src/terminal/Layers/Manager.idleWork.test.ts \
     src/terminal/Layers/Manager.idleWork.lifecycle.test.ts \
     src/terminal/Layers/Manager.shell.subprocess.test.ts \
     src/orchestration/Layers/ThreadOrganizationReactor.idle.paging.test.ts \
     src/persistence/Layers/ProjectionThreads.idle.paging.test.ts \
     src/orchestration/Layers/OrchestrationEngine.organizationIdle.test.ts
   ```

   Combined coverage from this run and the regression run below includes unknown/idle/busy, quiet generic harnesses, direct children, split-pane aggregation, retained completion and exact cutoff equality, close/natural exit/eviction, generation/epoch/PID/target fencing, restart/unresolved shutdown flags, inspection failures, remote transport uncertainty/reassessment, manual Later movement, both automatic source states, accepted no-op receipt replay, and an idle-selected candidate becoming busy before engine processing. SQLite paging tests pass 252 rows using at most 50 rows per query, exclusions, ties, effective organization-time anchors, short/empty pages, and independent policy-reset cursors. Full sweeper integration coverage was subsequently added and passed in the final combined run below.

4. This regression command completed **9 passing files / 48 passing tests**, with **2 failures** in the concurrently edited persistence idle suite (exit 1):

   ```sh
   bun run --cwd apps/server vitest run \
     src/terminal/Layers/Manager.agentDetection.test.ts \
     src/terminal/Layers/Manager.agentDetection.generic.test.ts \
     src/terminal/Layers/Manager.agentIdentity.failure.test.ts \
     src/terminal/Layers/Manager.agentIdentity.epoch.test.ts \
     src/terminal/Layers/Manager.process-drain.remote.test.ts \
     src/terminal/Layers/Manager.confirmedLifecycle.races.test.ts \
     src/terminal/Layers/Manager.confirmedLifecycle.test.ts \
     src/terminal/Layers/Manager.shell.test.ts \
     src/orchestration/Layers/ThreadOrganizationReactor.idle.test.ts \
     src/persistence/Layers/ProjectionThreads.idle.test.ts
   ```

   The failures were concrete snapshot mismatches: settled `later-control-{cancelled,completed,failed,superseded}` rows were absent while the production settled-control gate was still being edited; the broad query then included `later-incidental-update` created by the other test in the shared memory layer but omitted from its expected rows. No owner test expectation was changed by this implementer. Both were resolved in the current shared snapshot, verified by this fresh rerun, **2 files / 3 tests passed**, exit 0:

   ```sh
   bun run --cwd apps/server vitest run \
     src/persistence/Layers/ProjectionThreads.idle.test.ts \
     src/persistence/Layers/ProjectionThreads.idle.paging.test.ts
   ```

5. Explicit length, formatting, and lint checks initially covered 28 owned source/test paths; the terminal sweeper fixture/tests brought the final scope to **30 paths**. Final `bun run oxfmt --check` passed, exit 0; `bun run oxlint --report-unused-disable-directives` passed, exit 0 with **0 warnings/errors**; explicit length recheck passed, **all 30 paths ≤400 lines, maximum 400**. The new terminal fixture is 112 lines and its test is 190 lines. An initial unused `Effect` import after the subprocess split was removed. Plan-only formatter/link checks and scoped `git diff --check` passed. The other owner's `ThreadOrganizationReactor.idle.test.ts` was not formatted or edited after ownership was established.
6. The remaining sweeper coverage was completed after explicit authorization to use a small separate terminal-owned fixture when no shared harness appeared. `ThreadOrganizationReactor.terminalIdle.fixture.ts` registers no tests, uses the public sweep entry point, existing interval constant and Effect TestClock, and does not copy the other owner's wall-clock/wake fixture. Its separate suite passed **6 tests**, exit 0:

   ```sh
   bun run --cwd apps/server vitest run src/orchestration/Layers/ThreadOrganizationReactor.terminalIdle.test.ts
   ```

   For **each** rule it verifies busy/unknown veto and ordinary-shell eligibility, the full configured post-work quiet window, no move one tick before the boundary, and a move with the exact captured cutoff at equality. A fairness test reaches an eligible 261st row behind 260 alternating busy/unknown rows in six ticks, with exactly six ≤50-row queries and at most 300 fact reads, then verifies policy-change grace and root cursor reset. A real-engine test admits work after sweep selection but before serialized command processing, observes no persisted organization event, and confirms a manual Later move remains honored.

7. Final combined focused run passed **17 files / 73 tests**, exit 0:

   ```sh
   bun run --cwd apps/server vitest run \
     src/terminal/Layers/Manager.idleWork.test.ts \
     src/terminal/Layers/Manager.idleWork.lifecycle.test.ts \
     src/terminal/Layers/Manager.shell.subprocess.test.ts \
     src/terminal/Layers/Manager.agentDetection.test.ts \
     src/terminal/Layers/Manager.agentDetection.generic.test.ts \
     src/terminal/Layers/Manager.agentIdentity.failure.test.ts \
     src/terminal/Layers/Manager.agentIdentity.epoch.test.ts \
     src/terminal/Layers/Manager.process-drain.remote.test.ts \
     src/terminal/Layers/Manager.confirmedLifecycle.races.test.ts \
     src/terminal/Layers/Manager.confirmedLifecycle.test.ts \
     src/terminal/Layers/Manager.shell.test.ts \
     src/orchestration/Layers/ThreadOrganizationReactor.terminalIdle.test.ts \
     src/orchestration/Layers/ThreadOrganizationReactor.idle.test.ts \
     src/orchestration/Layers/ThreadOrganizationReactor.idle.paging.test.ts \
     src/orchestration/Layers/OrchestrationEngine.organizationIdle.test.ts \
     src/persistence/Layers/ProjectionThreads.idle.test.ts \
     src/persistence/Layers/ProjectionThreads.idle.paging.test.ts
   ```

   The final server typecheck initially caught one new test-only branded-ID expectation (`TS2322` at terminal sweeper test line 48); using the existing branded candidate factory fixed it. `bun run --cwd apps/server typecheck` then passed **exit 0**. Fresh contracts typecheck, all 30-file format/lint/length checks, and another 6-test terminal sweeper rerun also passed after that correction.

### Remaining qualification limits

- The shared-fixture coordination dependency is **closed** by the authorized, separate terminal-owned fixture and passing sweeper integration tests. No implementation blocker remains. The other owner's scheduler tests/production timing semantics remain intact.
- No live quiet OpenCode/Pi run beyond a configured idle threshold, drawer-hide/other-thread UI exercise, or live macOS/Linux/Windows/SSH/WSL matrix was performed. Current evidence is scoped automated tests on the macOS host with process/PTY fixtures; it must not be represented as live cross-platform qualification.
- Detached/untracked jobs remain outside the existing direct-child detector guarantee. The final recheck uses sampled server state, not atomic process-start admission. Persistent uncertainty may conservatively retain a thread indefinitely.
- No full repository checks, `bun test`, commit, push, or worktree were used.

## Acceptance Criteria

- A Present thread with observed running terminal work stays Present beyond its configured idle threshold, including quiet OpenCode/Pi sessions.
- Neither automatic rule moves observed running terminal work to Later/Done.
- A plain unused shell does not indefinitely retain its thread.
- Protection works without mounted terminal UI and uses existing server polling.
- After the final work ends, a complete configured quiet window elapses before automatic movement.
- Manual organization remains authoritative; no automatic resurrection of Later/Done threads.
- Stale runtime facts cannot revive or clear protection for the wrong terminal generation.
- Implementation has focused validation and honest platform/failure limitations, without unrelated terminal/provider changes.

## Open Questions

No user decision is required before implementation: this proposal recommends conservative subprocess protection, protection from both automatic rules, and a full post-work quiet window. Exact foreground-only treatment and ignoring background child jobs are explicitly outside this scope. Related workspace records remain unverified because the tools were unavailable.
