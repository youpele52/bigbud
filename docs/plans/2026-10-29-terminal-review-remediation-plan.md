# Terminal lifecycle review remediation

**Date:** 29 October, 2026
**Status:** Original seven fixes and six follow-up correctness fixes implemented and regression-tested in the working tree; configured server typecheck remains blocked by unrelated Effect diagnostics
**Owner:** Terminal reliability implementation (A)

## Summary

Close the seven source-review gaps in terminal ownership, input destination, remount recovery, fatal read handling, global event memory, partial setup cleanup, and device-query parsing. Preserve confirmed shell shutdown, remote ownership barriers, bounded output credit, retained diagnostics, and normal detached-job behavior.

## Related Work

- [Confirmed lifecycle and Orca follow-ups](2026-10-29-terminal-confirmed-lifecycle-plan.md): implemented working-tree baseline; its qualifications remain applicable.
- [Crash containment](2026-10-29-terminal-crash-containment-plan.md): existing adapter and viewport fault isolation.
- Notes/Kanban: none identified for this review follow-up; the preceding plan records the project-list inspection. The seven findings and explicit user request in this thread define the scope.
- Coordination: B's latest thread status is idle, with no active test/typecheck processes observed. This follow-up owns the listed files; do not start duplicate consolidation work in B.

## Problem

1. `Manager.session.close.ts:35` protects unknown remote ownership only for identityless Close. An expected generation can bypass that fence.
2. `TerminalViewport.input.ts:37` resolves generation when queued input drains, redirecting old paste tails after another client's restart.
3. `TerminalViewport.session.ts:247` pauses and unsubscribes after a transient snapshot refusal during startup; successful restart only hydrates the initiating view.
4. `NodePTY.ts:86` sends one default signal after fatal read failure, with no escalation if the shell ignores it.
5. `wsRpcHandlers.terminalEvents.ts:45` bounds output only; non-output events/snapshots remain unbounded.
6. `TerminalViewport.session.ts:185` does not register all acquired resources for partial cleanup.
7. `TerminalDeviceQueries.ts:66` abandons CSI on executable C0 controls and therefore misses valid device-attribute queries without a renderer.

## Goals

- Refuse Close while remote ownership is unresolved, regardless of generation; preserve lease/history on refusal.
- Never redirect accepted input to a different shell generation.
- Recover a mounted viewport when its predecessor initiated a successful Restart, including a transient snapshot failure during spawn.
- Bound fatal-read shutdown and retain a visible error rather than an unusable running view.
- Bound the entire global event backlog, not just output, without silently losing lifecycle state.
- Release every acquired viewport resource after partial setup failure.
- Answer valid stateless DA queries containing executable C0 controls while preserving control effects and ignoring string payloads.

## Non-Goals

No process-tree/group kill expansion, detached-job cleanup policy changes, dependencies, exact checkpoint protocol, remote historical query responses, stateful cursor/colour guesses, repository-wide checks, commits or pushes. Confirmed shutdown refers to the owned PTY shell/adapter, not every descendant.

## Current State

Server thread locks serialize Close/Restart; `Manager.process.stop.ts` retains uncertain process handles and the existing remote durable-release barrier. Client lifecycle identity survives view remounts; structured stale-generation recovery publishes snapshots through `terminalLifecycle.recovery.ts`. Launch binding already supports subscriptions. Per-session output streams have independent credit windows and resync. The global stream uses an Effect callback queue and the transport supports subscription reconnection. Partial view disposal already exists; extend rather than replace it. No persisted schema migration is needed.

## Phases

### Phase 1: Ownership and destination fences

- In `Manager.session.close.ts`, independently refuse unresolved recovery ownership before stop/release/delete, including generation-bound requests. Keep valid remote attached stop behavior and existing identityless guards.
- In `TerminalViewport.input.ts`, observe launch generation changes and clear pending input immediately; also compare the captured queue generation before dispatch. Keep one ordered queue, surrogate-safe paste chunks and local lifecycle gating.
- Extend `Manager.closeUnbound.test.ts` and input tests for matching generation with unresolved ownership, external restart mid-paste, same-generation snapshot updates, binding removal and disposal.
- Exit: old input cannot adopt a new generation, ownership refusals preserve history/lease and never signal an unrelated shell.

### Phase 2: Mounted view recovery and cleanup

- Publish successful lifecycle snapshots to current refresh subscribers, not only the initiating view. Subscription handlers must recover a paused lane and reattach read-only output before hydration when needed; do not open/restart a shell implicitly.
- Keep operation/generation fencing and ignore disposed listeners. Avoid duplicate replay when both RPC and scoped event deliver the same snapshot. Surface failed replacement snapshots without treating them as successful readiness.
- Extract the acquired-cleanup stack to a small adjacent helper if necessary to keep session code <=400 lines. Register input, links and selection immediately; release in reverse order on partial failure without suppressing the original error.
- Extend remount browser coverage: snapshot rejects while replacement starts, restarted event is missed because the old subscription ended, then RPC success restores current viewport. Add unit/resource cleanup failure injection.
- Exit: mounted view becomes usable without a second spawn, and repeated setup failures retain no global input listeners.

### Phase 3: Fatal read containment and query correctness

- Adapter-owned fatal read handling must be idempotent: mark I/O failed, initiate bounded graceful/forced shutdown of the same shell, cancel escalation on real exit, and publish failure to manager state without fabricating confirmed exit. Preserve benign EIO/EAGAIN filtering and stale process fences.
- Use a focused adjacent module rather than growing NodePTY beyond 400 lines. Extend the PTY contract only if necessary with an optional error observer, keeping Bun/remote adapters compatible.
- Preserve executable C0 effects while retaining pending CSI query recognition. CAN/SUB cancel; ESC restarts control parsing; string payloads remain uninterpreted. Keep split-chunk behavior and bounded parser buffering.
- Tests: fatal error with ignored HUP/TERM, escalation, signal failure, repeated errors, real exit cancellation, manager visible error, and embedded-control queries split at each boundary with no duplicated renderer response.
- Exit: no false stopped confirmation, no permanent running state after unusable I/O, no reply to stale/history/string payloads.

### Phase 4: Whole-stream memory ceiling

- Add total item and approximate character budgets including snapshots, with a hard bound on oversized first events. Keep lossy output dropping under the existing soft limit.
- When a lossless event cannot fit, terminate that subscriber explicitly and release its queued references. Use the existing transport resubscription/resync path; never block publication to other clients or pause PTYs for this global feed.
- Ensure reconnection provides current sidebar/agent state where events may have been missed. Inspect transport completion semantics before choosing end versus failure; use an existing resubscription mechanism rather than silently ending forever.
- Tests: activity/lifecycle-only backlog, history-heavy snapshots, oversized first event, bounded retained references, no offers after overflow, recovery and unaffected fast subscriber.
- Exit: full global backlog is bounded and lifecycle loss is explicit/recoverable.

### Phase 5: Focused validation and implementation record

Run changed-file formatting, lint, <=400-line checks, configured web/server/contracts typechecks where affected, and focused unit/server/Chromium suites serially to avoid resource contention. Record exact failures/blocked checks rather than importing earlier counts. Independently review the final diff against this plan. Update this record and the plans index; preserve unrelated dirty files.

## Risks And Decision Gates

- A matching generation is not evidence that a remote owner stopped. No release/delete follows uncertain recovery.
- Clearing queued input cannot retract an already dispatched RPC; its original expected generation must remain unchanged and the server fence remains authoritative.
- A transient attach failure must not cause implicit Open during a lifecycle operation. Successful completion must notify the current view even if the initiating view was disposed.
- Fatal read errors are not exit evidence. Escalation signals only the owned shell; uncertainty retains tracking and prevents replacement.
- A lossless stream overflow cannot be silently dropped: explicitly reconnect and reconcile state. Do not retry a completed stream in an unbounded hot loop.
- No destructive migration is involved. Rollback these changes with their tests as a coherent set; preserve existing ownership and input fences.

## Testing And Validation

Use explicit Vitest paths through `bun run --cwd apps/server vitest run ...`, `bun run --cwd apps/web vitest run ...` and `bun run --cwd apps/web test:browser ...`. Use scoped `oxfmt`/`oxlint` and the configured affected-package typecheck scripts. No `bun test`, full-suite or repository-wide checks. Test each finding at the failure layer, including deferred promises, queued chunks, startup snapshot refusal and source-specific PTY errors. Test harmless same-generation refreshes and ordinary successful Close/Restart to catch regressions. Existing headless Chromium/GPU and unrelated Muse diagnostics remain qualification limits only if reproduced; do not claim native Windows/Linux or packaged qualification without running it.

## Acceptance Criteria

- All seven findings are fixed or explicitly disproved with evidence and a documented alternative.
- Close retains unresolved ownership for both guarded and generation-bound requests.
- Input accepted for generation A never drains to B.
- Remount during slow Restart recovers without another Open/Restart or lost ownership fencing.
- Fatal read handling is bounded and truthful; failed view setup releases subscriptions/resources.
- Global event memory includes a total cap and explicit recovery on lossless overflow.
- Valid embedded-control DA requests receive one response, and string/history content receives none.
- Focused checks pass or unrelated blockers are reported accurately; source/test files <=400 lines; no unrelated changes, commits or pushes.

## Open Questions

None requiring a product decision. Specific queue recovery and adapter notification mechanics will follow the inspected runtime APIs, with outcomes recorded below before completion.

## Implementation Record

### Delivered fixes

1. **Unresolved ownership:** `Manager.session.close.ts` rejects unresolved recovery ownership independently of `expectedGeneration`. No stop, lease release or history deletion follows refusal. Successful process attachment clears the recovery-required marker, so a genuinely recovered owner can still close normally. Regression tests exercise both paths.
2. **Queued input destination:** the input attachment observes launch-binding changes and clears queued input before adopting a different generation or missing binding. Already dispatched requests retain their original `expectedGeneration`; same-generation snapshots preserve pending input. The server generation fence remains authoritative.
3. **Remounted replacement recovery:** successful Restart completion publishes the replacement snapshot to current lifecycle-refresh subscribers, even when the initiating view is gone. A paused view replaces only its delivery lane, resubscribes and hydrates; it does not issue another Open. A failed replacement also publishes its identity, keeps input paused and permits an explicit new Restart using that generation. Awaited subscription readiness cannot hydrate an obsolete delivery lane.
4. **Fatal PTY reads:** `NodePTY.readFailure.ts` latches failure, contains diagnostic/listener exceptions, fences writes/resizes and escalates HUP → TERM → KILL at one-second grace intervals. Only the owned PTY shell is signalled. Real exit cancels escalation. The optional PTY error observer marks the exact current manager process as failed while retaining its process/PID/lease until actual exit; error-state processes can still drain their real exit event.
5. **Whole global stream budget:** the global queue has hard limits of 2,048 events and approximately 4 Mi character units, including lifecycle snapshots, in addition to the existing output soft limits. Oversized optional output is dropped. Lossless overflow clears queued references and explicitly ends only that subscription; the existing transport backs off and resubscribes. Lightweight replay reconciles activity and exit/error state. WSL stopped/error state is included without overwriting running client-derived agent/activity detection. A stalled/fast subscriber test verifies isolation and subsequent subscription recovery.
6. **Partial setup rollback:** `TerminalSetupCleanup` releases acquired resources in reverse order, tolerates individual broken disposers and is idempotent. The viewport registers output, delivery, links, input, selection and lifecycle-refresh resources immediately. Input attachment itself rolls back global subscriptions/data listeners if later input setup throws. Repeated boundary reload failure is covered in Chromium. Link registration was extracted into the existing links module to keep the session module readable and below 400 lines (394 after formatting).
7. **Embedded-control queries:** the live DA parser preserves executable C0 effects while retaining ESC/CSI recognition. CAN/SUB cancel, new introducers restart syntax, string payloads remain uninterpreted, and overlong syntax uses bounded passthrough states. Only stateless DA1/DA2 replies are generated; no remote recovered history, cursor or colour replies were added.

### Review follow-ups

An independent source review found three additional edges during implementation: failed replacement snapshots were not reaching remounted views; WSL was excluded before lifecycle recovery replay; and exceptions inside input attachment could leak subscriptions before returning its disposer. All three were fixed and gained focused regression coverage. A separate final integration inspection checked ownership fences, exact-process failure tracking, stream completion/backoff, parser cancellation and acquired-resource cleanup.

The initially reported descendant-lifetime issue is not a required fix: confirmed stop intentionally refers to the owned shell/adapter, not every descendant. No process-tree/group killing or change to `nohup`/`disown` behavior was introduced.

### Validation evidence

All commands were scoped to affected files/packages and were run on macOS. Heavier regression, browser and typecheck runs were serialized. No repository-wide checks were run.

| Check                                                                                                                                            | Result                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client Vitest: `src/components/terminal`, launch-binding command tests, terminal event/identity stores and `wsTransport.retry-lifecycle.test.ts` | 58 files; **380 passed**.                                                                                                                                                                                                                      |
| Server Vitest: `src/terminal` plus `wsRpcHandlers.terminalEvents.test.ts` and `wsRpcHandlers.terminalSession.test.ts`                            | 51 files; **352 passed, 1 expected failure, 1 skipped** (354 cases). Exit 0.                                                                                                                                                                   |
| Final edge-case units: input, delivery lifecycle, restart and lifecycle recovery                                                                 | 4 files; **25 passed**, included in the final client regression above.                                                                                                                                                                         |
| Final edge-case server tests: subscription recovery, guarded Close and both terminal WS suites                                                   | 4 files; **24 passed**, included in the final server regression above.                                                                                                                                                                         |
| Shell-runner regressions: `src/shell/Layers/ThreadShellRunner.test.ts` and `ThreadShellRunner.readyTimeout.test.ts`                              | 2 files; **4 passed**. The earlier broad command included a nonexistent old provider path, so these were located and run separately rather than assuming coverage.                                                                             |
| Final Chromium: restart/remount, setup failure, lifecycle and error-boundary suites (after link extraction)                                      | 4 files; **8 passed**, including failed replacement identity adoption, slow startup snapshot refusal, explicit generation-safe retry and repeated setup failure cleanup.                                                                       |
| Explicit length checks on all 32 source/test files authored in this follow-up                                                                    | Pass; all <=400 lines. Session module: 394.                                                                                                                                                                                                    |
| `oxfmt --check` on those 32 files                                                                                                                | Pass.                                                                                                                                                                                                                                          |
| `oxlint --report-unused-disable-directives` on those 32 files                                                                                    | Exit 0; zero errors, one pre-existing `consistent-function-scoping` warning for `stalled` in `NodePTY.hardening.test.ts`.                                                                                                                      |
| Configured `apps/web` typecheck                                                                                                                  | Exit 0.                                                                                                                                                                                                                                        |
| Configured `packages/contracts` typecheck                                                                                                        | Exit 0.                                                                                                                                                                                                                                        |
| Configured `apps/server` typecheck                                                                                                               | **Exit 2**, not passed. Unrelated Effect warnings in Muse adapter inspection/send/start/resume code and informational diagnostics elsewhere; no diagnostics in terminal remediation files. No unrelated code was changed to hide this blocker. |

The server regression retains the existing expected-failure guard for node-pty 1.1.0 descriptor lifetime on macOS and its platform skip placeholder; neither is claimed fixed. The client run emits an environment warning about an invalid `--localstorage-file`; the server run emits Node's SQLite experimental warning.

An early stalled/fast-subscriber integration test starved both consumers by publishing in a tight microtask loop. It initially failed because the supposed fast consumer also overflowed. Yielding the event loop every 64 publishes made the intended isolated-stall scenario explicit; the focused and final server runs pass without changing production queue limits or test timeouts.

### Qualification and rollout limits

- The strict completion gate is **partial**, solely because the configured server typecheck still exits nonzero on unrelated diagnostics. Source implementation and scoped regression evidence are complete; this is not a claim that the entire repository is clean.
- No packaged/manual acceptance, live remote SSH-machine qualification, native Windows/Linux qualification or native fatal-read fault injection was performed. Mocked adapter tests do not establish those results.
- Existing real macOS PTY confirmed-stop tests run in the terminal scope, but they do not prove that all descendants terminate. Detached-job behavior remains intentional.
- This follow-up does not requalify GPU-driver memory reclamation or exact checkpoint recovery; existing plans' limits still apply.
- No dependencies, persisted migrations, process-tree policies, commits or pushes were introduced. Unrelated working-tree changes were preserved.
- Roll back this follow-up and its tests together if needed; retain the pre-existing generation fencing, confirmed-stop and remote durable-owner barriers. Do not restore a silent `exit` fallback as a workaround.

## Second correctness review: implementation and validation

The subsequent review of the implementation and the requested Minimize/centered Closing UI found six further correctness gaps. The user authorized fixing these on 29 October 2026. The earlier validation table describes the original seven-fix phase, not evidence that these later gaps were already closed.

### Follow-up scope and design

1. **Retained-session inspection:** remove the running-process precondition from the read-only manager snapshot operation. Return the retained session's truthful status, identity, output and PID without starting, resizing or signalling a shell. Missing sessions still fail. Stale-generation refusal recovery can now inspect exited and error sessions before a fresh explicit destructive intent.
2. **Startup supersession:** an epoch-based startup helper invalidates both pending responses and failures, including scheduled layout retries, when lifecycle recovery or delivery replacement supersedes the request. Unmount invalidates it too. Late startup errors cannot pause or unsubscribe a successfully recovered view.
3. **Monotonic snapshot adoption:** launch bindings retain `updatedAt`; one shared acceptance predicate rejects older snapshots before changing launch context, drop-path mode, links, viewport metadata or intake history. Lifecycle refresh uses a view's newer staged snapshot rather than an obsolete RPC response. Equal timestamps retain the existing legacy protocol semantics; this is not a new sequenced checkpoint protocol.
4. **Confirmed outcome versus presentation:** finish a definitive Restart/stale-refusal operation before awaiting view hydration. Renderer/subscription failures remain per-view failures and cannot turn a confirmed server result into an uncertain Restart or retain its retry identity. Presentation recovery has bounded waits and truthful view-specific timeout messages. Independent listeners are isolated; actual pre-response uncertainty still retains the original operation ID and parameters.
5. **Authoritative absence after overflow:** an opt-in inventory control item captures retained-session membership atomically with listener registration, before survivor replay and buffered live events. The global consumer flushes older batched events before absence reconciliation. Missing sessions lose stale activity/agent observations and event buffers, not panes, labels, layout or launch context. Newer observations and surviving WSL client-derived identity/activity are preserved. The existing bounded queue also bounds inventory; an oversized inventory ends the stream rather than applying incomplete membership.
6. **Numeric-zero DA forms:** primary and secondary DA accept zero-padded zero parameters, including split sequences and embedded executable controls. Nonzero/multiple/unsupported parameters, cancellation, strings and parser bounds remain unchanged. The immutable C1 lookup was also hoisted out of the character loop.

### Required regressions

- Retained exited/error snapshots after a stale refusal, processless launch error and owned read error; no snapshot-triggered spawn, resize, writes, signals or lifecycle events.
- Both late startup rejection and success after a remounted view has recovered; delayed generation B RPC response after newer generation C event, followed by a new Restart that still targets C and its directory.
- Rejected and stalled hydration/subscription readiness, another failed refresh listener, and healthy listener isolation. Confirmed lifecycle ownership is released independently; uncertain RPC retry identity is unchanged.
- Inventory following deletion/eviction after missed exit/activity, registration-time mutation ordering, absent drawer/panel state, preservation of newer observations and WSL survivors, RPC/native forwarding, and hard-budget overflow.
- Padded DA1/DA2 split at all boundaries, invalid parameters, exact buffer boundaries, C0 effects, CAN/SUB and string exclusion.

### Follow-up validation record

An independent source-only review of the follow-up found two more races, both corrected before final validation: a timed-out request's later success must fence a pending retry's subsequent failure-side view effects; and newer global launch metadata is not proof that a newly mounted delivery already has its history baseline. Failure handling now checks current operation identity, and a shared snapshot resolver fetches current history through the read-only snapshot API when no current local baseline exists. Still-stale responses produce a visible recoverable view failure, not silent readiness or an implicit shell start. Dedicated units and Chromium cover both scenarios, including concurrent snapshots for the same generation.

Final scoped checks on macOS:

| Check                                                                                                                                                      | Result                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web Vitest: terminal components, launch bindings/commands, event/identity/inventory stores, root terminal-event ordering, RPC client and native forwarding | **64 files, 413 passed**.                                                                                                                                                                                                                                        |
| Server Vitest: terminal manager/adapters/parser plus both terminal WS suites                                                                               | **52 files, 388 passed, 1 expected failure, 1 skipped**; exit 0. Existing node-pty descriptor-lifetime expected failure and platform placeholder skip are unchanged.                                                                                             |
| Chromium: restart/remount, lifecycle, setup failure, error boundary, centered Closing, both Chat layout suites and target picker                           | **8 files, 48 passed**. Includes Minimize preserving the shell/emulator and Close–Minimize–Maximize order.                                                                                                                                                       |
| Contracts Vitest: inventory, terminal and lifecycle schemas                                                                                                | **3 files, 28 passed**.                                                                                                                                                                                                                                          |
| Explicit formatter/linter/length checks                                                                                                                    | **46 authored source/test files passed**, zero lint warnings/errors; maximum 393 lines. The plan was formatted separately from the code-length rule.                                                                                                             |
| Configured web and contracts typechecks                                                                                                                    | Both **passed**, exit 0.                                                                                                                                                                                                                                         |
| Configured server typecheck                                                                                                                                | **Not passed**, exit 1. Existing unrelated Effect warnings in Muse adapter inspection/send/start/resume code and informational messages elsewhere; no terminal-follow-up diagnostics and no `error TS` lines. Log: `/tmp/terminal-correctness-server-types.log`. |

The first combined eight-file browser invocation stalled before Vitest emitted a run header and was stopped; a fresh final invocation completed with all 48 cases passing. An initial browser race test also exposed the newer-stream/older-RPC missing-local-baseline edge and passed after recovery was corrected. Unit isolation was updated to clear launch bindings along with terminal store state, so monotonic fences do not carry timestamps between independent tests. The final test commands use only existing explicit regression paths.

The earlier platform, packaged, remote-machine, detached-descendant and GPU/checkpoint qualification limits still apply. Authoritative absence requires the coordinated inventory-capable server/client path; an older server cannot supply this boundary. Inventory above the existing approximately 4-Mi-character budget deliberately fails closed rather than partially reconciling. No dependencies, persisted migrations, full-workspace checks, commits or pushes were introduced during implementation.

### Local commit preparation — 29 October 2026

The user subsequently authorized a detailed terminal-only local commit. Its scope includes crash containment, the delegated confirmed-lifecycle implementation, the review fixes and the requested Minimize/centered Closing UI. An isolated Git index separates the independent agent-logo edits in four shared terminal files and preserves the unrelated staged usage-file rename. No worktree was created.

- Repeated focused Vitest runs: web **64 files / 413 passed**; server **52 files / 388 passed, 1 expected failure, 1 skipped**; contracts **3 files / 28 passed**.
- Expanded sequential Chromium coverage adds recovery and GPU visibility to the earlier eight-file scope: **10 files / 56 passed**. The first expanded run failed three recovery cases because launch bindings leaked newer timestamps between tests. Recovery teardown now forgets its launch binding; the entire expanded scope passed after that test-isolation fix. An intermediate isolated rerun was stopped when the cleanup was applied and is not counted as passing evidence.
- Explicit formatting, lint and the 400-line cap pass for all **122 selected source/test files**; the four selectively staged source blobs also pass formatting and lint. The original whole-scope lint found one test-helper scoping warning, corrected by hoisting the stalled-check helper; its **11 focused cases passed** again. Documentation formatting and relative plan links are checked separately.
- Configured web and contracts typechecks pass. The repeated configured server typecheck remains **not passed, exit 2**, on unrelated Effect warnings in Muse send/start/resume and client error code, plus informational diagnostics elsewhere; no `error TS` or terminal diagnostics. Log: `/tmp/terminal-commit-server-types.log`. This is still a partial strict verification gate, not a clean repository claim.
- No full-suite or workspace-wide checks were run. The commit authorization does not authorize a push.
