# Terminal crash containment and bounded failure plan

**Date:** 29 October, 2026
**Status:** Implemented in the working tree (not committed); manual checks pending
**Owner:** bigbud engineering (implementer agent)

## Summary

The terminal already has strong client-side reliability: credit-based output flow control, bounded write lanes, a write watchdog, WebGL fallback and gated hydration. The remaining crash risk sits mostly on the server, where PTYs run inside the main backend process. A small number of unguarded paths let one terminal fault become a defect, a stuck session or, in the worst case, an uncaught exception that ends the whole backend, taking chat and provider sessions with it.

This plan contains those faults in the current in-process architecture. Each change is small, local and independently safe. It does not change the terminal's normal behavior, protocols, defaults or UI except for one new fallback panel that only appears when a terminal view throws.

## Related Work

- Bigbud note or Kanban card: None identified. Workspace tools were not ready when this plan was written, so notes and cards could not be searched.
- [Terminal reliability/GPU plan](2026-10-10-terminal-rust-gpu-reliability-plan.md): owns the native PTY owner (P5), exact checkpoints, source cuts and sequenced reconnect (P6), and the health lane (P7). This plan must not pre-empt those designs.
- [Terminal owner security contract](2026-10-10-terminal-owner-security-contract-plan.md): owns descendant containment (P5c) and process ownership rules.
- [Scoped terminal output architecture](2026-09-30-terminal-scoped-output-architecture-plan.md): established the per-session delivery stream and the `legacyDetection` global stream scope used below.
- External references used for design comparison:
  - [xterm.js flow control guide](https://xtermjs.org/docs/guides/flowcontrol/)
  - [VS Code terminal constants](https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/platform/terminal/common/terminal.ts) and [terminalProcess.ts](https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/platform/terminal/node/terminalProcess.ts), which validate the shell and wrap node-pty calls before and after spawn.
  - [Zed persistent terminal RFC](https://github.com/zed-industries/zed/discussions/50584)

## Problem

Each item below was verified in source or by experiment on 29 October, 2026.

1. **A tty read error can end the backend.** node-pty rethrows any read-stream error other than EAGAIN or EIO when fewer than two `error` listeners exist (`node_modules/.bun/node-pty@1.1.0/node_modules/node-pty/lib/unixTerminal.js:99-126`; same pattern in `windowsTerminal.js:80-93`). bigbud registers no listener (`apps/server/src/terminal/Layers/NodePTY.ts:51-96`). The server only installs `uncaughtExceptionMonitor` (`apps/server/src/serverLifecycleDiagnostics.ts:14`), which logs but does not prevent exit.
2. **A synchronous spawn throw becomes a defect.** `nodePty.spawn` is called directly inside the generator (`NodePTY.ts:117-127`) and `Bun.spawn` inside `Effect.sync` (`BunPTY.ts:98-113`). `trySpawnWith` and `startSessionWith` only capture typed failures with `Effect.result` (`Manager.process-drain.ts:79-110, 210-287`). A throw skips the shell fallback chain and the error branch, leaving the session in `starting` with no process.
3. **A missing shell is never detected.** Experiment with node-pty 1.1.0 on macOS: spawning `/nonexistent/shell-xyz` or the non-executable `/etc/hosts` succeeds and then exits with code 1 and no output. The fallback chain in `trySpawnWith` never runs, so a stale `$SHELL` produces a terminal that exits immediately on every open. The hidden thread shell (`apps/server/src/shell/Layers/ThreadShellRunner.runner.ts:128-185`) waits for its readiness timeout before giving up.
4. **node-pty load failure aborts server startup.** `Effect.promise(() => import("node-pty"))` turns an ABI or prebuild failure into a layer defect (`NodePTY.ts:104`, consumed by `apps/server/src/server.ts:101-111`), which stops chat, files and providers too.
5. **Terminal log directory failure aborts server startup.** `makeDirectory(logsDir).pipe(Effect.orDie)` (`Manager.process.ts:99`).
6. **Resize after exit raises a defect.** `resize` and `write` run in `Effect.sync` (`Manager.session.controls.ts:16,27`) and `open` calls `session.process!.resize` directly (`Manager.session.ts:62-66`). node-pty throws on resize of a closed descriptor. RPC defects are contained (`disableFatalDefects: true`, `apps/server/src/ws/ws.ts:69`), so this is noise and an untyped client error rather than a crash.
7. **Output hold can apply a stale decision.** `makeTerminalOutputHold` decides pause or resume from a captured holder set after an asynchronous session lookup (`Manager.session.outputHold.ts:17-32`). If a holder set is removed and replaced while a call is suspended, a stale empty set can resume a PTY that a newer holder paused. The worst case is extra buffering up to the delivery overflow limit, not a stuck terminal.
8. **Eviction can remove a session that is starting.** `evictInactiveSessionsIfNeeded` treats every non-`running` session as inactive, including `starting` (`Manager.process.ts:225-253`). A session evicted mid-start would spawn a PTY outside the session map. This needs more than 128 inactive sessions and is rare, but the fix is one condition.
9. **The global terminal event stream has an unbounded server queue.** `subscribeTerminalEvents` offers every event into a default `Stream.callback` queue (`apps/server/src/ws/wsRpcHandlers.terminalSession.ts:26-39`), whose capacity defaults to unbounded. Effect RPC over WebSocket waits for a client acknowledgement after each chunk (`supportsAck: true` in `effect@4.0.0-beta.43 RpcServer.js:835-905`, latch at `:240-272`), so a stalled client makes this queue grow. Remote and WSL output is still carried on this stream for client-side agent detection (`apps/server/src/terminal/Layers/Manager.session.subscription.ts:11-25`). A runaway remote process with one stalled client can therefore grow backend memory without limit.
10. **No error boundary surrounds the terminal view.** Only two React error boundaries exist in the web app. A throw while creating an xterm view (`apps/web/src/components/terminal/TerminalViewport.view.ts:26-99`, called in `TerminalViewport.session.ts:78-85`) unmounts the whole chat view. A throw partway through view creation also leaks the partially created emulator.
11. **Large pastes are discarded.** `TerminalInputQueue.take` sends an oversized item whole (`TerminalInputQueue.ts:70-74`), while the server write schema caps data at 65,536 code units (`packages/contracts/src/workspace/terminal.ts:58`). A larger paste fails validation, after which the queue clears all pending input by design.
12. **Hydration acknowledges output it has not parsed.** During hydration the intake parks live events in `pending` (`TerminalViewport.intake.ts:49-81`), but the stream's outstanding credit counts only the write batcher (`TerminalViewport.session.ts:140`). Parked output is acknowledged as parsed, the server refills its window, and a busy terminal can overflow the 1 MiB intake cap during a reconnect or tab switch. The view then pauses with an overflow error.

## Goals

- No single terminal fault can end the backend process.
- Spawn failures always end in a typed `error` session state with a clear message, and the shell fallback chain engages for missing or non-executable local shells.
- A failed native module or log directory degrades only terminals, not the server.
- Backend memory used by the global terminal event stream is bounded per client.
- A terminal view crash is contained to that view and recoverable without restarting the shell.
- Pastes of any size reach the shell in order.
- Hydration during live output no longer overflows because of premature acknowledgements.

## Non-Goals

- No separate PTY host process, native owner, sequenced reconnect protocol or exact checkpoint. These belong to the reliability plan's P5 and P6.
- No change to credit windows, hold water marks, overflow limits, history caps, scrollback, watchdog timing, GPU policy or renderer selection.
- No process-group kill or ledger reaping on close. Closing the PTY master already sends SIGHUP to the shell session. Group kill would break intentional `nohup` or `disown` jobs and belongs to the owner plan's P5c.
- No dependency upgrades. node-pty stays on stable 1.1.0 and xterm packages stay on their current builds.
- No change to `historyExists` or `readHistory` failure semantics. `historyExists` feeds `remoteOwnerRecoveryRequired`, and guessing a default could duplicate or orphan a remote shell.
- No edits to files that other threads are changing in this worktree: `Manager.agentDetection.ts`, `terminalAgents.ts`, `terminalTaskTitle.ts`, `ThreadTerminalDrawer.tsx`, `ThreadTerminalDrawerSidebar.tsx`, `useThreadTerminalDrawer.ts`, `terminalDisplay.ts`, `stores/terminal/*`, and `packages/contracts/src/constants/terminal.constant.ts`.
- No new global `uncaughtException` handler. It would hide unrelated bugs.

## Current State

- **Server data path.** The PTY adapter emits data. The manager coalesces it, appends bounded history and publishes events. Two RPC streams deliver them: the per-session stream with a credit window and PTY hold (`apps/server/src/terminal/TerminalOutputDelivery.ts`), and the global lifecycle stream filtered by `outputScope: "legacyDetection"`.
- **Adapter selection.** Bun in development uses `BunPTY`; Node in production uses `NodePTY` (`apps/server/src/server.ts:101-111`). The same adapter also backs `ThreadShellRunnerLive` and is wrapped by the remote-agent adapter for remote targets (`server.ts:278-315`).
- **Retry classification.** `isRetryableShellSpawnError` matches messages and causes containing `posix_spawnp failed`, `enoent`, `not found`, `file not found` or `no such file` (`apps/server/src/terminal/Layers/Manager.shell.ts:176-221`).
- **Client data path.** The WebSocket session stream feeds `TerminalSessionStream`, which acknowledges `received - outstanding`. Events pass through the intake hydration gate, then the write batcher, then xterm.
- **Baseline test state before this work.**

| Suite                                                      | Result                                           |
| ---------------------------------------------------------- | ------------------------------------------------ |
| Server `src/terminal` and `src/ws/wsRpcHandlers.terminal*` | 40 files, 246 passed, 2 expected fail, 1 skipped |
| Web `src/components/terminal` unit                         | 45 files, 289 passed                             |
| Web terminal and drawer browser tests                      | 22 of 23 files passed                            |

The one browser failure is pre-existing: `ChatView.terminalDrawer.browser.tsx` "warm thread/layout switches retain measurable emulators" expects a real WebGL-to-DOM measurement and fails in this headless environment.

## Behavior To Preserve

The implementation must keep all of these unchanged. The listed tests protect them and must stay green.

- Shell selection and fallback order, environment sanitising, WSL and remote candidates (`Manager.shell.test.ts`, `Manager.wsl*.test.ts`, `Manager.remote*.test.ts`).
- Kill escalation, shutdown cleanup, leases and eviction counts (`Manager.lifecycle.test.ts`, `Manager.lease.test.ts`, `Manager.startup.test.ts`).
- Delivery credit, hold and overflow semantics (`TerminalOutputDelivery.test.ts`, `Manager.outputDelivery.test.ts`, `wsRpcHandlers.terminalSession.test.ts`).
- Lifecycle events on the global stream: started, restarted, exited, error, cleared, activity and agent identity are never dropped.
- Input ordering, coalescing and drop-on-failure (`TerminalInputQueue.test.ts`, `TerminalViewport.input.test.ts`).
- Hydration gating, historical reply suppression and resync (`TerminalViewport.intake.handoff.test.ts`, `TerminalSessionStream.test.ts`, `TerminalViewport.hydration.browser.tsx`, `TerminalViewport.recovery.browser.tsx`).
- View lifetime, focus, splits and renderer fallback (`TerminalViewport.*.browser.tsx`, `ChatView.terminal*.browser.tsx`).

## Phases

### Phase 1: Server crash containment

Independent of later phases and safe to ship alone.

1. **Error listener on node-pty processes.** In `NodePTY.ts`, register an `error` listener on every spawned `IPty` through its forwarding `on` method. The listener logs a warning with the pid and error code, then kills the process so `onExit` fires and the session reaches `exited`. node-pty has already closed reading and writing at that point, so the terminal is unusable either way. A failing kill is swallowed.
2. **Typed spawn failures in adapters.** Wrap `nodePty.spawn` and `Bun.spawn` in `Effect.try`, mapping throws to `PtySpawnError` with the original error as `cause` and its message in `message`.
3. **Defect guard in the manager.** In `trySpawnWith`, pipe `ctx.ptyAdapter.spawn(...)` through `Effect.catchDefect`, mapping a defect to `PtySpawnError` with adapter `terminal-manager`. This covers every adapter, including the remote-agent wrapper, and routes failures through the existing retry and error branches.
4. **Local shell executability check.** Add `apps/server/src/terminal/Layers/PtyShellExecutable.ts` with a pure-ish helper that resolves a shell on POSIX: paths containing `/` are resolved against the spawn cwd; bare names are searched on the spawn environment's `PATH` and then the server's `PATH`. A candidate passes when it is a regular file with execute permission. Both local adapters call it before spawning, except on Windows. On failure they return `PtySpawnError` with message `ENOENT: shell not found or not executable: <shell>`, which the existing retry check already classifies as retryable. The manager is not changed, so tests that drive fake shell paths through `FakePtyAdapter` keep their current behavior.
5. **Unavailable adapter when node-pty cannot load.** Replace `Effect.promise` with `Effect.tryPromise` in `NodePTY.layer`. On failure, log one error and return an adapter whose `spawn` fails with `PtySpawnError` message `Terminal support is unavailable: node-pty failed to load.` and the import error as cause. Bun's Windows `Effect.die` is left alone because it only affects unsupported development use.
6. **Non-fatal terminal log directory.** Replace `Effect.orDie` on the log directory creation with a warning log. History persistence already logs and continues on write failure.
7. **Typed resize and write failures.** In `Manager.session.controls.ts`, use `Effect.try` and map throws to `TerminalNotRunningError`. In `open`, wrap the reattach resize in a try that logs at debug level and still returns the snapshot, because reattach must not fail on a resize race.
8. **Live hold decision.** In `makeTerminalOutputHold`, decide pause or resume from the current map entry (`holders.get(key)?.size ?? 0`) after the session lookup, not from the captured set.
9. **Eviction skips starting sessions.** Filter `status !== "running" && status !== "starting"` in `evictInactiveSessionsIfNeeded`.

**Tests.** Extend `FakePtyAdapter` with an opt-in synchronous throw and defect mode. Add manager tests for a defecting adapter ending in `error` with a published `error` event and for a defect followed by a working fallback shell. Add adapter tests for `PtyShellExecutable` covering absolute, relative, bare, missing, directory and non-executable shells. Add a NodePTY test that a spawned missing shell fails with a retryable `PtySpawnError`, skipped on Windows. Add a test that an `error` emitted on the node-pty socket does not throw and leads to exit. Add controls tests for resize and write throwing after exit, a hold race test, and an eviction test that preserves a starting session.

**Exit criteria.** All new and existing server terminal tests pass. A manual run with `SHELL=/nonexistent` opens a working fallback shell.

### Phase 2: Bounded global terminal event stream

Depends on nothing in Phase 1.

1. Add `apps/server/src/ws/wsRpcHandlers.terminalEvents.ts` with a small bounded offer helper for the global stream. Non-output events are always offered. Output events are offered only while the queued output since the queue was last empty stays under 1 MiB of UTF-16 code units and 1,024 items. When the queue is observed empty, the counters reset, because the RPC stream drains the entire queue per chunk.
2. Dropped output is counted per subscription. Log one warning when dropping starts and one summary with the dropped count when the queue drains.
3. Use the helper in the `subscribeTerminalEvents` handler. The per-session stream is unchanged.

**Why this is safe.** On the client, this stream's output only feeds heuristic agent-name matching for remote and WSL terminals. Mounted views read their own per-session stream. Dropping some output under heavy backlog can delay agent-name detection; it cannot affect what the terminal shows.

**Tests.** Unit tests for the helper: lifecycle events pass while output is dropped, counters reset after drain, and limits apply to both characters and items. Keep `wsRpcHandlers.terminalSession.test.ts` green.

**Exit criteria.** Backend memory for a stalled client is bounded by the limits above plus lifecycle events.

### Phase 3: Client containment

Depends on nothing on the server.

1. **View error boundary.** Add `apps/web/src/components/terminal/TerminalViewportErrorBoundary.tsx`. It catches render and effect errors from one viewport, logs them to the console, and shows a compact panel: a `text-sm` message saying the terminal view stopped unexpectedly and the shell is still running, plus a shadcn `Button` labelled "Reload terminal view". The button remounts the child with a new key; remounting reattaches through `open`, which never restarts a running PTY. Wrap both `TerminalViewport` sites in `ThreadTerminalDrawerViewport.tsx`.
2. **Partial view cleanup.** In `createTerminalView`, collect each created resource and dispose the collected ones in reverse order if a later step throws, then rethrow. The returned object and the success-path dispose order stay the same.
3. **Paste chunking.** Export `TERMINAL_WRITE_MAX_CODE_UNITS = 65_536` from `packages/contracts/src/workspace/terminal.ts` and use it in the write schema. In `TerminalInputQueue.take`, split an item longer than the limit at a surrogate-safe boundary and return the remainder to the front of the queue. Byte order, coalescing and failure behavior stay the same.
4. **Hydration credit accounting.** Give `TerminalViewportIntake` a `pendingOutputChars` count of parked output and an optional `onCreditReleased` callback. It is called when parked output is discarded without being applied, because the snapshot already covers it. Without that callback, a hydration that discards every parked event would never trigger another acknowledgement and the stream would stall. In `TerminalViewport.session.ts`, report outstanding as batcher credit plus intake parked credit, and wire `onCreditReleased` to the stream's `parsed`.

**Tests.** Boundary test that a throwing child shows the fallback and that reload remounts it. View test that a throwing addon step disposes the created terminal. Queue tests for splitting a 200,000-unit paste, surrogate pairs at the boundary and order with surrounding input. Intake and stream tests that parked output is not acknowledged, that discarded parked output releases credit and triggers an acknowledgement, and that applied output keeps credit until parsed.

**Exit criteria.** All existing web terminal unit and browser tests keep their baseline results, and the new tests pass.

## Risks And Decision Gates

- **Executability check false negatives.** A sandbox or unusual filesystem could fail the access check for a shell that would run. The impact is a fallback to the next shell, which is visible but not fatal. The check never runs on Windows or for non-local adapters.
- **Kill on read error.** The process is killed only after node-pty has already closed the terminal's reads and writes. Nothing reachable is lost.
- **Dropped detection output.** Only remote and WSL agent-name matching can lag under backlog. Lifecycle state is unaffected.
- **Credit accounting change.** Counting parked output makes the server wait during hydration. Hydration does not depend on live output, so the wait ends when parked output is applied or discarded. The release callback prevents the stall case.
- **Concurrent work.** Other threads are editing nearby terminal files. This plan touches none of them. If any planned file changes underneath the implementation, stop and re-read it before editing.
- **Gate for later work.** Sequenced reconnect, retained emulators across tab switches, poll consolidation and process isolation require the reliability plan's gates or the end of the concurrent drawer and agent-detection work.

## Testing And Validation

Focused commands only, per repository rules:

```sh
bun run --cwd apps/server vitest run src/terminal src/ws/wsRpcHandlers.terminal
bun run --cwd apps/web vitest run src/components/terminal
bun run --cwd apps/web test:browser src/components/terminal src/components/chat/view/ChatView.terminal
bun run --cwd packages/contracts vitest run src/workspace
bunx oxfmt --check <changed files>
bunx oxlint <changed files>
bun run --cwd apps/server typecheck
bun run --cwd apps/web typecheck
bun run --cwd packages/contracts typecheck
```

Also check the 400-line limit for every changed code file. Full-suite and repository-wide checks need separate approval.

Manual checks for the user after implementation:

- Set the configured shell to a missing path and open a terminal. Expect a working fallback shell.
- Paste a file of about 200 KB into `cat > /dev/null`. Expect no error notice.
- Run `yes` in a terminal, switch threads and back, and reconnect the network. Expect no hydration overflow error.
- Run `yes` in a remote terminal with the app window minimised for a minute. Expect stable backend memory.

## Acceptance Criteria

- No code path in the terminal adapters or manager lets a node-pty error event, spawn throw or missing native module end the backend or abort its startup.
- A missing or non-executable local shell falls back to the next candidate.
- Spawn failures of every kind end with session status `error` and a published `error` event.
- Resize or write after exit returns a typed error.
- The global event stream bounds queued output per subscription and never drops lifecycle events.
- A throwing terminal view shows the fallback panel, keeps the rest of the chat view, and can be reloaded without restarting the shell.
- Pastes larger than the write limit arrive complete and in order.
- Parked hydration output is acknowledged only after it is parsed or discarded.
- Every suite in the baseline table keeps its baseline result, and all new tests pass.

## Open Questions

- Should CI run the terminal browser tests? They hold most of the view reliability guarantees but no workflow runs `test:browser` today. A job existed earlier and disappeared during the rebrand, so this is a cost and policy decision for the user. One test also needs a GPU-independent expectation before it can gate CI.
- Should the deferred items be scheduled once the concurrent drawer and agent-detection work lands? They are listed below.

## Deferred Items

| Item                                                                       | Reason deferred                                                                                                  |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Sequence numbers for reconnect cutoffs                                     | Owned by the reliability plan's P6 source cuts.                                                                  |
| Keep xterm mounted across tab switches                                     | Touches drawer files under concurrent edit, and P6c defines view reconstruction.                                 |
| Single process snapshot instead of per-terminal `pgrep`                    | `Manager.agentDetection.ts` is under concurrent edit.                                                            |
| Process-group kill and startup reaping                                     | Kernel SIGHUP already ends the session on master close. Group kill changes `nohup` semantics and belongs to P5c. |
| BunPTY pause and resume                                                    | Development only, and Bun's terminal API has no reader pause.                                                    |
| Dropping history of exited sessions                                        | Would remove exited terminals from global terminal search.                                                       |
| Atomic history writes and shutdown flush                                   | History content is not replayed today.                                                                           |
| Watchdog tuning, WebGL auto-retry, policy IPC caching, parked-view polling | Performance or UX items without a reproduced crash.                                                              |
| Routing system notices through the write batcher                           | Covered by P6b's authority provenance audit.                                                                     |
| node-pty 1.2 and xterm build alignment                                     | Stable dependency preference. Revisit when 1.2 is stable.                                                        |

## Implementation Record

**Implemented:** 29 October, 2026, in the working tree on `feature/computer-use`. Nothing was committed.

### Changes beyond the original plan text

Two changes are behavior differences from the plan as first written. The rest close gaps found by an independent review against this plan.

- **Leak guard update.** The pre-spawn shell check stops node-pty 1.1.0 from leaking a pseudo-terminal on failed spawns on macOS. `NodePTY.leak.test.ts` "returns to the baseline after failed spawns" changed from an expected failure to a normal test. The leak on normal exits is still an expected failure on stable node-pty.
- **Eager adapter throws.** The manager's spawn call is wrapped in `Effect.suspend`, so an adapter that throws before returning an Effect is also converted to `PtySpawnError`.
- **View cleanup after creation.** `TerminalViewport.session.ts` releases the output subscription, delivery and view if session setup throws after the view exists. Without this, reloading a deterministically crashing view could leak WebGL contexts.
- **Global stream bound.** The first output event into an empty backlog is always admitted, because one coalesced event can exceed the limit. Real memory per subscriber is about twice the limits: one chunk awaiting acknowledgement plus the queue.
- **Windows read errors.** EAGAIN is benign only on Unix, matching node-pty's per-platform handlers.
- **Paste chunking.** The chunk size is clamped to at least two code units, so a leading surrogate pair always makes progress.
- **Bounded shell check.** Prompted by Orca's fixes for stalled network paths ([#31381](https://github.com/stablyai/orca/pull/31381), [#33643](https://github.com/stablyai/orca/pull/33643)), the check now covers only shell paths that contain a slash. Bare names are left to the spawn's own PATH lookup, and a check that has not answered within one second lets the spawn proceed. This keeps a dead network mount on `PATH` from parking Node filesystem workers.
- **Fallback copy.** The panel says reloading reattaches without restarting, instead of claiming the shell is running.

### Not done

- **SIGKILL escalation after a read error.** The read-error path sends node-pty's default SIGHUP. A shell that ignores SIGHUP would stay `running` with closed descriptors until closed. This was optional in review and is left as is.
- **Manual checks.** The four manual checks in Testing And Validation have not been run yet.
- **CI.** No CI workflow change. See Open Questions.

### Validation

Final focused runs after all review fixes:

| Suite                                                      | Before                                           | After                                            |
| ---------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| Server `src/terminal` and `src/ws/wsRpcHandlers.terminal*` | 40 files, 246 passed, 2 expected fail, 1 skipped | 44 files, 266 passed, 1 expected fail, 1 skipped |
| Web `src/components/terminal` unit                         | 45 files, 289 passed                             | 48 files, 300 passed                             |
| Web terminal and drawer browser tests                      | 22 of 23 files passed                            | 23 of 24 files passed                            |
| Contracts `workspace/terminal.test.ts`                     | not run                                          | 22 passed                                        |

After the bounded shell check, the server suite was rerun: 44 files, 269 passed, 1 expected fail, 1 skipped.

**Concurrent work.** While this was being finished, another thread began refactoring the terminal manager. It added `Manager.process.stop.ts`, `Manager.session.generation.ts` and `Manager.session.restart.action.ts`, and edited `Manager.session.ts`, `Manager.process-lifecycle.ts` and others. Its in-progress code currently fails the server typecheck with `makeTerminalRestart` undefined in `Manager.session.ts`, and the Muse adapter work also has three type errors. Neither comes from this plan. This plan's edits in the shared files are intact.

Format and lint are clean on all changed files. Web and contracts typechecks pass. The largest changed code file is 394 lines.

Pre-existing results that are not caused by this work:

- **Server typecheck.** `apps/server` typecheck reports no errors. It exits non-zero only because of three warnings in another thread's untracked Muse adapter files.
- **Drawer browser test.** `ChatView.terminalDrawer.browser.tsx` "warm thread/layout switches retain measurable emulators" fails in headless Chromium before and after this work.
