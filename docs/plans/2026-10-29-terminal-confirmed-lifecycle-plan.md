# Terminal confirmed lifecycle and Orca follow-ups

**Date:** 29 October, 2026
**Status:** Implemented in source — strict verification gate remains partial on unrelated server diagnostics
**Owner:** Terminal reliability implementation thread

## Summary

Make explicit Close and Restart responsive but truthful: never report a shell stopped or start its replacement without a confirmed stop. Preserve existing flow control, remote ownership fences, target/cwd/env bindings, normal background-job behavior, and non-destructive view recovery.

## Related Work

- [Terminal crash containment](2026-10-29-terminal-crash-containment-plan.md): earlier PTY/view containment, bounded delivery and paste/credit protection; preserve these changes.
- [Terminal reliability/GPU](2026-10-10-terminal-rust-gpu-reliability-plan.md): authoritative terminal-state and remote replay work; do not imply this follow-up establishes exact recovery.
- Orca lessons supplied in the thread: filesystem isolation, stateless terminal-query handling and hidden GPU resource release. Adapt to bigbud's supported APIs and ownership boundaries.
- Project notes and Kanban: none identified for this specific Close/Restart follow-up after inspecting project lists. The user request and related repository plans are the source of scope.

## Problem

Close removed UI state before shutdown acknowledgement and used a silent `exit\n` fallback when RPC failed. Restart scheduled local termination in the background, allowing a replacement to overlap its predecessor. Early transcript clearing discarded useful failure evidence. Shell checks could stall on filesystem paths; identification queries could be lost at snapshot boundaries; hidden GPU resources could remain allocated indefinitely.

## Goals

Confirmed, bounded and recoverable lifecycle operations shared by chat and panel terminals; retained diagnostics on failure; the three Orca follow-ups without weakening flow control, remote ownership or detached-job compatibility.

## Non-Goals

No new process-group/tree kill policy, `nohup`/`disown` behavior changes, automatic port-based killing, dependency upgrades, full authoritative cursor/color-query emulator, or new synchronous filesystem work. Operation retry fencing is in-memory for the current server session, not a durable exactly-once guarantee across server crashes.

## Current State

- Server lifecycle: `apps/server/src/terminal/Layers/Manager.process-drain.ts`, `Manager.process.stop.ts`, `Manager.session.close.ts`, `Manager.session.restart.action.ts`; thread locks serialize lifecycle operations, generation checks reject stale requests, and remote adapters retain their durable-release barrier.
- Client lifecycle: `apps/web/src/components/terminal/terminalLifecycle.operations.ts`, `TerminalViewport.restart.ts`, `TerminalViewport.session.ts` and `stores/terminal/terminalLifecycle.store.ts`; app-session operation ownership survives view remounts.
- Renderer/input: `TerminalRendererController.ts`, `TerminalViewport.input.ts`, `lib/terminalLaunchBinding.command.ts`; input guards must cover scripts as well as interactive bytes.
- Orca adaptations: `PtyShellExecutable.ts`/`.pending.ts`, `TerminalDeviceQueries.ts`, and `TerminalRendererController.ts`.

## Phases

Each step depends on the earlier lifecycle contracts where applicable; the independent filesystem/query/renderer steps preserve those contracts and meet their focused tests before final regression review.

1. Add bounded, exit-confirmed local PTY shutdown, subscribed before signaling. Resume paused reads so exit can drain. Keep the process handle and lease on uncertain shutdown; retain the existing remote durable-termination barrier for both close and restart. Ordinary shutdown still signals only the existing PTY target, not detached process trees.
2. Fence user lifecycle requests by expected runtime generation. Give restart requests an operation identity so a lost successful response can be retried without another spawn. Reject stale requests; do not infer a definitive stop from an RPC timeout.
3. Share a client lifecycle coordinator between chat and panel terminals. Reserve operations before asynchronous work; expose Closing / Stopping / Starting and recoverable errors. Remove UI/store state and launch bindings only after close confirmation. No clear-before-close or silent `exit\n` fallback. Move focus to another terminal when available without removing the pending item.
4. Gate terminal input and automatic reopening during lifecycle operations. Preserve previous visible/server diagnostics if a replacement fails. Keep the existing restart confirmation and pre-registered output stream. Hiding, thread switching and reconnecting never trigger close/restart.
5. Orca filesystem lesson: skip speculative PATH traversal for bare shell names, bound explicit-path preflight checks, and share outstanding checks so a timeout does not accumulate new filesystem work. Missing/non-executable explicit shells still reach the existing fallback chain.
6. Orca query lesson: own stateless primary/secondary device-attribute requests at live local/WSL server output ingress, before history/snapshot cuts. Remote replay streams are deliberately excluded until fresh output can be distinguished safely from recovered replay. Match the installed xterm replies, handle split sequences, remove handled requests from renderer output to prevent double replies, and ignore embedded query-shaped bytes in OSC/DCS payloads. Never answer stale replay or fabricate cursor/color state. Other stateful query support remains part of the existing authoritative terminal-state plan.
7. Orca GPU lesson: release hidden WebGL drawing resources after a grace period; restore on visibility without changing PTY size/model/history or losing fallback support. Prefer public addon lifecycle over private renderer mutations.
8. Focused regression tests, formatting/lint, affected package typechecks, source/test lengths <=400 lines. No repository-wide checks, commits or pushes without fresh approval.

## Risks And Decision Gates

- A timeout is uncertain; keep process/lease ownership and the original retry identity. Never infer permission to create another shell.
- Resolve launch target/cwd/env before stopping a working shell. Retain transcript on failed replacement. On successful replacement preserve the established empty-transcript behavior.
- Natural exit can precede the stop observer. Store process-specific exit evidence synchronously; a retry must not wait for an event that already occurred.
- Retention eviction must exclude sessions owned by a restart and any uncertain session retaining a process handle.
- Delayed typography/subscription/materialization can overlap Close. Read lifecycle ownership immediately before Open and before scripted writes; fence writes to their returned runtime generation.
- A definitive stale-generation refusal permits snapshot reconciliation and a fresh user decision. Network failures/timeouts do not permit resetting identity. No destructive operation is automatically retried against the refreshed session.
- Initial launch failure may provide no identity. A server-checked `onlyIfNotRunning` close can remove an absent/stopped pane; any live or unresolved remote owner must cause refusal.
- Remote replay cannot safely distinguish every historical query from fresh output; do not enable automatic query replies there. Stateful cursor/colour queries remain excluded.
- Hidden GPU cleanup changes only addon resources. Retain the emulator model, scroll/selection, geometry and PTY; preserve the DOM fallback and cancel timers on disposal.
- No persistence migration is involved. Client full reload/server crash ends in-memory operation receipts; do not claim durable exactly-once recovery. Rollback must deploy matching client/server contracts and must not replay failed user commands.

## Testing And Validation

- Close waits for actual exit; TERM exit avoids KILL; ignored TERM escalates; ignored KILL errors and keeps ownership; signal errors are recoverable.
- Restart cannot spawn before old exit; timeout leaves old generation tracked; duplicate operation cannot respawn; stale close/restart cannot affect a newer generation.
- Failed replacement retains diagnostic history; successful restart retains existing empty-transcript behavior.
- Closing is visible, blocks competing restart/input, keeps the UI item until acknowledged, preserves it on error, and never writes `exit\n`.
- Lifecycle state survives component remounts in the same app session; view setup does not automatically reopen a shell while lifecycle ownership is pending/uncertain.
- Shell preflight handles missing executable, bare names and stalled checks within its deadline.
- DA1/DA2 answers before any view attaches, across chunk boundaries and reconnect snapshot cuts, with no duplicate renderer reply or false query inside a string control sequence.
- Hidden GPU resources are released only after the grace period, restored on show, and timers canceled on disposal.

Additional review regressions: restart at zero inactive retention; exit before stop-listener registration; signal failure/retry; Close during font readiness; script launch/write during lifecycle ownership; structured stale refusal refreshing current views; identity-free safe close and refusal. Run scoped `oxfmt`/`oxlint` paths, explicit file-length checks, configured server/web/contracts package typechecks, focused Vitest suites and Chromium terminal tests. No full-suite/repository checks without approval.

## Acceptance Criteria

Ready for implementation. This plan follows the latest approved scope: confirmed Close/Restart plus the three Orca follow-ups. Earlier crash-containment changes remain in place. Aggressive detached-job cleanup remains excluded.

| Requirement                                | Implementation boundary                                                             | Acceptance evidence                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Truthful Close/Restart                     | Server stop confirmation and generation fences; shared client operation state       | Deferred exit, escalation, retries, stale-generation and browser lifecycle tests |
| Preserve diagnostics and safe recovery     | Retain transcript on failure; block input/automatic open during lifecycle ownership | Failed replacement, remount, input gating and recovery tests                     |
| Preserve remote safety and launch identity | Existing durable remote barrier, target/cwd/env and worktree leases                 | Remote restart/ownership and launch-binding regressions                          |
| Bounded filesystem work                    | Explicit-path deadline and shared outstanding preflight                             | Missing/bare/stalled-shell tests                                                 |
| Live stateless query replies               | Server ingress parser; no history replay answers or stateful guesses                | Split-query, embedded-string, no-view and stream tests                           |
| Hidden GPU release                         | Public addon dispose/recreate after 30 seconds                                      | Timer, visibility, fallback and context-loss tests                               |
| Existing terminal reliability              | Existing credit, paste, rendering, hydration and recovery paths                     | Focused server/web/contracts regression suites                                   |

## Open Questions

None for the agreed implementation scope. Packaged/manual and native platform qualification remain separate evidence limits, not permission to weaken lifecycle guarantees.

## Implementation Record

Working-tree implementation and bounded independent review are complete. Review follow-ups add server-guarded identityless Close and propagate live lifecycle snapshots into remounted view metadata; their regression checks are included below. No commit or push was made.

### Scoped validation — 29 October 2026

- Server terminal regressions: 46 files, 296 passed, one expected failure and one skipped. The expected failure is the existing stable node-pty macOS descriptor-leak guard, not a newly accepted lifecycle failure.
- Additional native macOS PTY smoke tests: two passed. A real `/bin/sh` confirms exit after TERM; a shell ignoring TERM confirms exit after KILL. These tests exercise the confirmed-stop helper, not packaged end-to-end UI flows.
- Remote-owned PTY termination barrier and terminal event RPC regressions: two files, seven tests passed.
- Client terminal unit regressions and launch binding: 56 files, 354 tests passed.
- Chromium lifecycle/status/recovery/visibility/remount: six files, 15 tests passed with file parallelism disabled. The remount regression starts Restart, disposes the original viewport, attaches to the old generation, completes Restart, and verifies the next Restart targets the fresh generation. An earlier parallel run intermittently missed the large-history recovery toast; that file passed in isolation and in the sequential scoped run. Test teardown now clears the intentionally remount-persistent lifecycle state; error assertions explicitly target the lifecycle banner rather than matching both banner and toast.
- Terminal contracts: four files, 36 tests passed, including optional generation fences, guarded identityless Close, restart-operation identity and legacy-request compatibility.
- Web and contracts package typechecks passed. Server package typecheck remains nonzero (exit 2) because of existing Effect diagnostics in concurrent Muse provider files; it reported no TypeScript errors or terminal-layer diagnostics. This is a blocked package check, not a claimed pass.
- Final review-closure rerun: three server files, 30 tests passed, including guarded identityless Close, persisted-owner/history-marker protection, lifecycle races and device-query assertions. These overlap the terminal suite above and must not be added as 30 unique extra tests.
- Focused formatter/linter, whitespace checks and the 400-line source/test cap passed after review fixes.

### Qualification limits

- No packaged app/manual acceptance run or native Windows/Linux qualification was performed.
- Remote lifecycle behavior retains the existing definitive-exit/durable-owner-release barrier and has manager regression coverage; no new live SSH-machine qualification was performed.
- Client ownership survives component remounts for the current app session, not a full app reload. Server restart-operation deduplication is in-memory and is not a durable exactly-once receipt across server crashes.
- Starting is the client replacement-snapshot/hydration phase, not a new authoritative server phase event.
- Hidden WebGL cleanup disposes the supported addon after 30 seconds; actual GPU-driver memory reclamation timing is not guaranteed.
- No repository-wide/full-suite checks were run. Detached-job cleanup policy is unchanged.

### Final follow-ups and evidence — 29 October 2026

- Closed review races: delayed view setup rechecks lifecycle immediately before Open; script input respects operation ownership and the returned generation; restart reserves its session against eviction, including at zero inactive retention; process-specific exit evidence survives an operation-local listener race.
- Definitive stale-generation refusals refresh current bindings/views and require a fresh user decision. Uncertain outcomes retain the original operation identity.
- Identity-free Close is allowed only when the server can establish no tracked/unresolved owner. An absent session with persisted recovery evidence refuses both identity-free and generation-fenced closes before lease/history mutation.
- Producer holds cannot re-pause shutdown reads; failed shutdown restores the current hold policy. Final partial escape/control bytes are flushed before exit. No aggressive process-tree or detached-job policy was introduced.
- Final source review: all seven behavior groups complete; no unresolved source issue. Verification is partial solely on the existing server package diagnostic failure below.

| Scoped command/check                                                                                                                                                                                                                                                                                                              | Final result                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit changed-file `oxfmt --check`, `oxlint --report-unused-disable-directives`                                                                                                                                                                                                                                                | Pass, zero warnings/errors; 59 source/test paths plus the two plan documents                                                                                                                                                        |
| Explicit changed-file line counts                                                                                                                                                                                                                                                                                                 | Pass; 59 source/test files <=400 lines, largest 399                                                                                                                                                                                 |
| `bun run --cwd apps/server vitest run src/terminal src/ws/wsRpcHandlers.terminalEvents.test.ts src/remote-agent/remoteAgentOwners.restart.test.ts src/remote-agent/remoteAgentOwnedPty.restart.test.ts src/remote-agent/remoteAgentOwners.race.test.ts src/remote-agent/remoteAgentPtyClient.close.test.ts --no-file-parallelism` | 50 files; 304 passed, one existing expected failure and one skip                                                                                                                                                                    |
| Final server follow-ups: `Manager.confirmedLifecycle.races.test.ts`, `TerminalDeviceQueries.test.ts`, `Manager.session.outputHold.test.ts`, `Manager.closeUnbound.test.ts`                                                                                                                                                        | 31 passed before the final owner/hold refinements; refined owner/lifecycle/remote suite 18 passed, then final owner/hold/races suite 12 passed                                                                                      |
| `bun run --cwd apps/web vitest run src/components/terminal src/lib/terminalLaunchBinding.test.ts src/lib/terminalLaunchBinding.command.test.ts`                                                                                                                                                                                   | 55 files; 352 passed                                                                                                                                                                                                                |
| Stale-recovery, operations, restart and delivery-lifecycle focused unit tests                                                                                                                                                                                                                                                     | Four files; 21 passed; corrected branded toast identity also passes package typecheck                                                                                                                                               |
| `bun run --cwd apps/web test:browser src/components/terminal --no-file-parallelism`                                                                                                                                                                                                                                               | Final rerun: 23 files, 57 passed, including remount/restart, hydration and GPU visibility                                                                                                                                           |
| `bun run --cwd packages/contracts vitest run src/workspace/terminal.test.ts src/workspace/terminal.lifecycle.test.ts`                                                                                                                                                                                                             | Two files; 25 passed                                                                                                                                                                                                                |
| `bun run --cwd apps/web typecheck` / `bun run --cwd packages/contracts typecheck`                                                                                                                                                                                                                                                 | Both exit 0 after final source corrections                                                                                                                                                                                          |
| `bun run --cwd apps/server typecheck`                                                                                                                                                                                                                                                                                             | Exit 2: six unrelated existing Effect warnings in Muse `Adapter.inspection`, `Adapter.sendTurn`, `Adapter.startSession.resume` and `Adapter.startSession`; no TypeScript errors or terminal diagnostics. Not a passed package check |
| Plan relative links and scoped `git diff --check`                                                                                                                                                                                                                                                                                 | Pass                                                                                                                                                                                                                                |

Earlier browser attempts exposed brittle concatenated fixture-label assertions (fixed with separate status selectors) and a GPU hydration timeout. An unchanged isolated GPU test subsequently passed and the final entire terminal browser scope passed; no timeout was increased. The timeout's cause was not established. The pre-existing chat-level `ChatView.terminalDrawer.browser.tsx` baseline failure remains outside this final terminal-directory run and is not claimed fixed or passed. No full repository/workspace checks were run.
