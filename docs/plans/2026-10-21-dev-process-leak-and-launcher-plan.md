# Dev process leak and dev launcher lifecycle

**Date:** 21 October, 2026
**Status:** Phases 1–4 implemented on 22 October 2026 (uncommitted); Phase 5 deferred (D2)
**Owner:** bigbud desktop, server and dev-tooling maintainers

## Summary

Every dev server restart in `bun dev:desktop` can strand provider child processes. The observed leftovers were Cursor `agent --trust acp` and `kilo serve` processes, reparented to launchd and running for days. One snapshot on 21 October 2026 counted 42 Cursor agents (about 3.8 GB) and 12 Kilo servers (about 1.3 GB), all with `BIGBUD_DESKTOP_PACKAGED=0`. Separately, quitting the dev Electron app does not end the dev session. The launcher also relaunches the app on the next rebuild.

This plan does four things:

- It makes the dev launcher stop the whole app process tree, including provider grandchildren.
- It defines what quitting and restarting the dev app mean.
- It bounds server-side provider teardown so a graceful stop fits its budget.
- It hands crash-proof cleanup of provider children whose server died to the Rust background-service plan (D2, decided).

Phases 1–3 change only dev tooling and dev-only code paths. Phase 4 changes shipped server code (see "Impact on the packaged app").

## Related Work

- [Optional Rust-owned background service](2026-10-15-rust-background-service-plan.md), Proposed. It owns the packaged desktop backend lifetime, `backendShutdown.ts`, `killProcessTree` semantics and a future managed-resource ledger. This plan must not change packaged desktop shutdown. Per D2, crash-proof cleanup of orphaned provider children is that plan's responsibility.
- [Connection resilience plan](2026-10-21-connection-resilience-plan.md). Same investigation. Covers WebSocket reconnect policy, resume from the last applied event, and the Rust supervisor's link health.
- Bigbud note or Kanban card: none identified. The work came from a direct investigation in a chat thread, not from a tracked item.

## Problem

### Observed facts

- **Orphans come from the dev checkout.** Every orphaned Cursor agent carried `BIGBUD_DESKTOP_PACKAGED=0`, `BIGBUD_DEV_REPO_ROOT=/Users/youpele/DevWorld/bigbud` and `cwd` set to the repo. Every orphaned `kilo serve --hostname=127.0.0.1 --port=0` matched the v1 managed-server spawn in `apps/server/src/provider/Layers/Opencode/ServerManager.child.ts:125`. Ten Kilo orphans were started between 12:12 and 13:23 on 17 October, which matches a heavy rebuild session.
- **They die on SIGTERM.** A SIGTERM sent to one orphaned Cursor agent and one orphaned Kilo server made each exit immediately. Their stdio sockets had no peer. They never exit on their own when the server disappears, but they honor the signal. Nobody sends it.
- **Graceful stop rarely completes in dev.** The `runStopAll` span in `~/.bigbud/dev/logs/server.trace.ndjson*` completed only three times on 21 October, at 10:14, 11:33 and 12:59, taking 0.60 s, 0.60 s and 1.09 s. The dev server restarted at least at 17:55 and 18:39 with no matching span. A Kilo server started at 17:55:26 by the first of those servers was orphaned at the 18:39 restart. The trace cannot distinguish "teardown never ran" from "teardown was killed before the span ended", but either way it did not finish.
- **Graceful teardown is near the kill budget.** The slowest observed completion of 1.09 s is close to the 1.5 s dev force-kill budget, and it grows with the number of live sessions.
- **The previous dev Electron's direct children exited cleanly.** These were `cua-driver serve`, `cua-driver mcp`, a Claude child and its MCP helper. That confirms that what leaks is grandchildren of Electron, namely provider children of the server.

### Current dev lifecycle

- **Launch chain.** `bun dev:desktop` runs `scripts/dev-runner.ts`. That spawns turbo with `detached: false` and `forceKillAfter: "1500 millis"` (`:205–219`). Turbo runs one `scripts/dev-supervise.ts` per package. For desktop that supervises the server tsdown watcher, the desktop tsdown watcher and `apps/desktop/scripts/dev-electron.mjs`.
- **Rebuild restart.** `dev-electron.mjs` watches `dist-electron/{main,preload}.js` and `../server/dist/bin.mjs` (`:16–19`, `:157–173`). On change it calls `stopApp()` (`:98–133`): SIGTERM to Electron plus `pkill -TERM -P <electronPid>`, then after `forcedShutdownTimeoutMs = 1_500` (`:20`) SIGKILL to Electron plus `pkill -KILL -P <electronPid>`. `pkill -P` reaches only Electron's direct children, meaning the server and cua-driver. It never reaches the server's children.
- **What happens when the server is killed.** If the server is SIGKILLed, or Electron is SIGKILLed while the server is still tearing down, the provider children of the server are reparented to launchd. Nothing ever signals them again.
- **Why "detached" is not the cause in dev.** Effect's Node spawner defaults to `detached: true` on non-Windows (`@effect/platform-node-shared` `NodeChildProcessSpawner.js:316`). Cursor agents therefore lead their own process group. That is actually useful during a graceful stop: scope close calls `process.kill(-pid)` and also kills Cursor's `worker-server` grandchild. It does not matter in dev, because nothing signals the server's descendants by group or by pid once the server is gone. An earlier recommendation in the investigation to switch ACP to `detached: false` is withdrawn for that reason.
- **Clean quit.** When the user quits the dev app with Cmd+Q, Electron exits with code 0. `dev-electron.mjs` does not restart on a clean exit (`:91–93`), but it keeps running with its watchers active. The next rebuild calls `scheduleRestart()`, finds `currentApp === null` and starts a new app. The tsdown watchers and Vite also keep running.
- **Restart menu.** The floating-assistant Restart calls `app.relaunch()` (`apps/desktop/src/main.ts:125–129`). In dev, the relaunched Electron is not a child of `dev-electron.mjs`. The launcher sees a clean exit, and the next rebuild starts a second instance alongside the unsupervised one. `cleanupStaleDevApps()` (`:48–54`) only runs at launcher start.
- **Server teardown is unbounded and sequential.** `makeRunStopAll` (`apps/server/src/provider/Layers/ProviderService.operations.ts:284–310`) persists bindings, then runs `adapter.stopAll()` for each adapter one after another (`:303`). The Cursor adapter stops its sessions sequentially (`Cursor/Adapter.ts:287–296`). Each ACP scope close sends SIGTERM to the group and waits for exit with no `forceKillAfter` (`AcpSessionRuntime.ts:155–170`). One unresponsive child can stall teardown indefinitely.
- **Budgets that must stay ordered.** `DEV_SUPERVISOR_GRACE_MS = 5_000` (`scripts/dev-supervise.lib.ts:22`) is documented as "dev-electron's own Electron shutdown (1.5 s) plus its child grace (1.2 s)". Any change to the dev-electron budget must keep the supervisor grace larger.
- **Windows dev.** `killChildTreeByPid` and `killChildTree` return early on Windows (`dev-electron.mjs:40–46`, `:175–182`). The dev launcher therefore has no tree kill there today. `dev-supervise` uses `taskkill /T /F` on Windows.

### Unattributed item

- An `opencode serve --service` process started at 11:48 on 21 October had no `VITEST` variables and had `TERM_PROGRAM=bigbud`. No non-test server code spawns `--service`. The only spawners are `OpencodeV2/SharedService.native.fixture.ts:95,183` and `SharedService.native.child.fixture.ts:32`. Both fixtures close the child via `closeOwnedChild`. The fixture may strip test variables through `isolatedEnvironment`, or the process may have been started by hand from a bigbud terminal. It is not attributed, and Phase 1 only checks it.

## Goals

- A rebuild-triggered dev restart leaves no provider process from the previous server running.
- Ctrl+C on any dev mode leaves no bigbud dev process running.
- Quitting the dev app ends the whole `bun dev:desktop` session (D1, decided: option A).
- The dev Restart menu relaunches under the launcher's supervision, with exactly one app instance.
- Server-side provider teardown is bounded, in both dev and packaged builds.
- Budgets across dev-runner, dev-supervise, dev-electron and the server are ordered and documented in one place.

## Non-Goals

- No change to packaged desktop shutdown, `backendShutdown.ts`, `backendProcess.ts`, updater quiescence or the desktop supervisor protocol. Those belong to the Rust background-service plan.
- No background mode, no keep-alive after quit, no Rust parent-death guard. Those also belong to the Rust plan.
- No change to which provider processes exist or how sessions resume.
- No reduction of the server tsdown watcher's memory. Its footprint comes from the single-bundle design (`apps/server/tsdown.config.ts`), not from a leak.

## Current State

See Problem. Key files:

| Area                        | File                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Dev mode wiring             | `scripts/dev-runner.ts`, `scripts/dev-runner.lib.ts`                                                                      |
| Per-package supervisor      | `scripts/dev-supervise.ts`, `scripts/dev-supervise.lib.ts`, test `scripts/dev-supervise.test.ts`                          |
| Dev Electron launcher       | `apps/desktop/scripts/dev-electron.mjs` (no unit tests)                                                                   |
| Desktop quit and Restart    | `apps/desktop/src/main.ts` (399 lines, at the limit)                                                                      |
| Provider stop-all           | `apps/server/src/provider/Layers/ProviderService.operations.ts`, `ProviderService.ts:357–361`                             |
| ACP child spawn             | `apps/server/src/provider/acp/AcpSessionRuntime.ts:155–170`                                                               |
| Kilo and OpenCode v1 server | `apps/server/src/provider/Layers/Opencode/ServerManager.child.ts`, `ServerManager.helpers.ts`, `ServerManager.ts:212–218` |

## Phases

### Phase 1: Reproduce and instrument (dev only)

**Goal.** Confirm which kill strands the children before changing behavior, and give later phases a measurable check.

1. In `dev-electron.mjs`, log one line per stop: `graceful` or `forced`, elapsed milliseconds, and pids still alive after escalation.
2. Write a manual reproduction procedure in this plan's validation section:
   - Start `bun dev:desktop`.
   - Open one Cursor thread and one Kilo thread, and send one turn in each.
   - Run `touch apps/server/dist/bin.mjs`.
   - Count bigbud dev processes with parent pid 1.
3. Check whether the server printed its existing `bigbud server exit` line (`apps/server/src/serverLifecycleDiagnostics.ts:17–19`). Its absence means the server was SIGKILLed.
4. Run the OpenCode V2 native tests once, then check for a surviving `opencode serve --service`. If it survives, file the fixture fix as a separate task. Otherwise record it as not reproduced.

**Exit criteria.** The reproduction shows orphans on unpatched code, and the log says which escalation produced them.

**Results (22 October 2026).**

- The launcher now logs one line per stop: `[dev-electron] stop graceful elapsed=<ms>` or `[dev-electron] stop forced elapsed=<ms> killed=<pids> survivors=<pids>`. On Windows it logs `stop forced (taskkill /T /F)`.
- Before the live run, a real-process model ran: an Electron stand-in that SIGTERMs its server and quits after 0.5 s, a server whose stderr is a pipe to Electron (as in dev) and that logs during a 3 s provider teardown, and two detached provider stand-ins. The old `stopApp()` orphaned both providers in 3 of 3 runs, because the server died of EPIPE once Electron had exited. The new stop orphaned none in 3 of 3 runs (`stop forced elapsed≈4.2s killed=<both providers> survivors=none`).
- Live `bun dev:desktop` (22 October, isolated `BIGBUD_HOME` under `/tmp`, clean env). At startup the dev server spawns `kilo serve` and five Cursor `agent --trust acp` processes.
  - Old launcher: forced stops. The server became a zombie about 1.5 s into the stop, and Electron and the server were SIGKILLed at 4 s.
  - Double SIGTERM: the old launcher sent SIGTERM to Electron and `pkill -P` to the server, while Electron's `stopBackend()` also sent SIGTERM. Effect's `NodeRuntime.runMain` drops its signal handlers after the first signal, so the second SIGTERM kills the server with no teardown (verified: one signal gives exit 130 with teardown, two give 143 with none). The new stop signals only Electron.
  - Zombies: `kill(pid, 0)` succeeds on a zombie, which made every stop look forced. The listing now reads `stat` and treats Z as gone.
  - Dev Electron's main thread can stay blocked (a JS-invoked `usleep`, seen with `sample`) for seconds after a signal-driven quit, even once its backend has exited; an Apple-event quit took between 1 s and 17 s. The pre-change launcher masked this with its 1.5 s SIGKILL. The launcher now gives Electron 500 ms once the backend subtree has drained, then SIGKILLs it. This is a desktop follow-up, not fixed here.
  - New launcher: 3 rebuild restarts gave 0 orphans. Server, Kilo and Cursor drained gracefully each time; only Electron and its cua-driver helpers were SIGKILLed after the backend drained. Restarts took about 1.9–2.4 s (1.5 s before).
  - Cmd+Q equivalent (`osascript -e 'tell application id "ai.bigbud.desktop.dev" to quit'`): the launcher logged `app quit; ending the dev session`, `bun dev:desktop` exited 130, and no processes were left with parent pid 1.
  - Server SIGTERM to exit took 1.4–1.9 s with live Kilo and five Cursor agents, an upper bound for `runStopAll`.
- That model explains the missing `runStopAll` spans: in dev the server's stderr and fd3/fd4 are pipes into Electron (`backendManager.ts`), so teardown logging after Electron exits can kill the server before `stopAll` finishes. This is a hypothesis for the real server, not yet confirmed against its `bigbud server exit` line. Packaged builds pipe stdout and stderr too, so the same exposure exists there; it belongs to the Rust plan (D2).
- The old `stopApp()` also had an ordering bug: it SIGKILLed Electron before `pkill -KILL -P <electron>`, so the server was already reparented and escaped the forced kill.
- Effect `4.0.0-beta.43`'s `forceKillAfter` bounds only delivering the first signal. Scope close then waits for the exit with no limit (measured: 5.7 s for a TERM-ignoring child with `forceKillAfter: 1s`). Phase 4 therefore adds an explicit SIGTERM → 2 s → SIGKILL release.
- `opencode serve --service`: not reproduced. The native fixtures refuse to launch any binary without an approved isolation record, and `V2_NATIVE_ISOLATION_APPROVALS` is empty. The surviving process (started 21 October 11:48) has `_=/Users/youpele/.opencode/bin/opencode`, `PWD=/Users/youpele/DevWorld` and `TERM_PROGRAM=bigbud`, which points to a hand-started shell command in a bigbud terminal. No fixture fix is filed.

### Phase 2: Tree-aware stop in the dev launcher (dev only)

**Goal.** No provider grandchild survives a dev restart or launcher shutdown, even when the server is killed.

1. **Extract the process-tree walker.** Move `processTree` from `scripts/dev-supervise.ts:37–56` into a shared module such as `scripts/lib/dev-process-tree.ts`, so both supervisors use one implementation. Keep the Windows branch.
2. **Split the launcher.** Move the stop and restart state machine out of `dev-electron.mjs` into a testable module with an injected host, mirroring `DevSupervisor`. The script keeps only the wiring.
3. **New stop sequence:**
   - Snapshot Electron's full descendant tree by parent pid before sending any signal. This captures provider children while they are still parented.
   - Send SIGTERM to Electron and its direct children, as today. The server then runs its graceful teardown.
   - Wait up to a graceful budget. The proposed value is 4 s, aligned with Phase 4.
   - Re-snapshot, union with the first snapshot, and SIGKILL every member still alive.
4. **Windows.** Use `taskkill /pid <electron> /T /F` instead of returning early. Windows does not reparent, so the tree walk still finds the server's children.
5. **Budget ordering.** Raise `DEV_SUPERVISOR_GRACE_MS` so it exceeds the new launcher shutdown: graceful budget plus child grace plus margin, proposed 8 s. Update the comment at `dev-supervise.lib.ts:22`. Leave the turbo `forceKillAfter` in dev-runner unchanged. `dev-supervise` detects its own orphaning independently.

**Why not broader alternatives.** Killing the whole process group would also kill turbo, Vite and the watchers that share it. Matching orphans by environment variables at launcher start needs `ps -E` on macOS and `/proc/<pid>/environ` on Linux, and could kill processes from another checkout. Both are rejected.

**Known hole.** If the server crashes on its own, Electron's backend manager restarts it and the launcher never runs a stop. This plan does not cover that case. Per D2 it is handed to the Rust background-service plan (see Phase 5).

**Exit criteria.** The Phase 1 reproduction shows zero orphans across ten consecutive rebuild restarts. Unit tests cover snapshot, escalation, reparented survivors and Windows dispatch.

### Phase 3: Quit and Restart semantics (dev launcher plus a dev-only desktop branch)

**Goal.** Quitting and restarting the dev app behave predictably.

1. **Clean quit.** Implement option A, chosen on 21 October 2026 (D1):
   - A clean, user-initiated Electron exit that the launcher did not request ends the whole `bun dev:desktop` session.
   - Mechanism: `dev-runner.ts` passes its own pid in a variable such as `BIGBUD_DEV_RUNNER_PID`. On a clean unexpected exit, `dev-electron` sends SIGINT to that pid. That reuses the existing Ctrl+C path: dev-runner interrupts turbo, and every `dev-supervise` stops its tree.
   - Check this against the installed turbo docs before relying on turbo's persistent-task behavior, as `AGENTS.md` requires.
2. **Restart in development.** When `isDevelopment` is true, the Restart handler exits with a sentinel exit code instead of calling `app.relaunch()`. `dev-electron` treats that code as "restart under supervision". Packaged builds keep `app.relaunch()` unchanged.
3. **File split.** `apps/desktop/src/main.ts` is at 399 lines. Move the floating-assistant quit and restart callbacks (`:121–130`) into a focused module before adding the branch.

**Exit criteria.** Cmd+Q on the dev app ends the whole dev session. The dev Restart menu yields exactly one app instance, supervised by the launcher.

### Phase 4: Bounded server teardown (shipped server code)

**Goal.** A graceful stop finishes within a known budget in both dev and packaged builds.

1. **ACP children.** Add `forceKillAfter` to the ACP spawn in `AcpSessionRuntime.ts:157`. The proposed value is 2 s. Keep the default `detached: true` so group kill still reaches Cursor's worker grandchild.
2. **Concurrent stop-all.** In `makeRunStopAll`, run `adapter.stopAll()` concurrently with a per-adapter timeout, logging any adapter that times out. Keep the binding persistence before the stop and the directory upserts after it, in their current order.
3. **Concurrent sessions within an adapter.** Make the Cursor adapter's `stopAll` and its finalizer stop sessions concurrently with bounded concurrency. Check the other ACP-based adapters for the same sequential pattern.
4. **Leave Kilo and OpenCode v1 alone.** Their close already escalates to SIGKILL after 1 s (`ServerManager.helpers.ts:28`) and runs in its own layer release.

**Exit criteria.** With Cursor, Kilo, Codex and Claude sessions live, `runStopAll` completes in under the per-adapter budget. Existing ProviderService and Cursor adapter tests pass, and new tests cover the timeout path.

### Phase 5: Deferred to the Rust background-service plan (D2)

**Decision.** On 21 October 2026, the user chose to build crash-proof orphan cleanup in Rust, as part of the [Rust background-service plan](2026-10-15-rust-background-service-plan.md), rather than as a TypeScript ledger here. No TypeScript provider-child ledger or startup sweep will be added.

**Requirements handed to that plan.** Its managed-resource ledger or native containment should cover these cases:

1. Provider children of a server that crashed or was SIGKILLed, including Cursor ACP agents with their own process group and Kilo or OpenCode v1 servers sharing the server's group.
2. Matching by pid together with start time and executable, never by pid alone.
3. Platform containment: a kqueue process watch on macOS, `PR_SET_PDEATHSIG` or a subreaper on Linux, and a Job Object with kill-on-close on Windows.
4. The same behavior in dev and packaged builds. The dev launcher fixes in Phases 2 and 3 do not cover a server that crashes on its own while Electron stays up.

**Until then.** A server crash in dev or packaged builds can still leave provider children running. The orphan check in Testing And Validation finds them, and sending them SIGTERM by hand remains the workaround.

## Impact on the packaged app

| Phase | Ships in the build | Effect on the packaged app                                                                                                                                                                                                                                  |
| ----- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | No                 | None. The scripts are dev-only.                                                                                                                                                                                                                             |
| 2     | No                 | None. `apps/desktop/scripts/*` and `scripts/*` are not packaged. The artifact stages only `apps/desktop/dist-electron/**` from `src/main.ts` and `src/preload.ts`, plus the server bundle (`scripts/lib/desktop-artifact/resources.ts:19`, `build.ts:162`). |
| 3     | Partly             | The quit and restart callbacks move to a new module inside the desktop bundle. The new branch runs only when `isDevelopment` is true, so packaged Restart and Quit behave exactly as today.                                                                 |
| 4     | Yes                | Quit and update handoff get a bounded server teardown. Today an unresponsive provider child can stall it. Behavior changes only when a child ignores SIGTERM, which is now force-killed after the budget.                                                   |
| 5     | No                 | Not built here. Deferred to the Rust background-service plan (D2).                                                                                                                                                                                          |

## Risks And Decision Gates

- **D1, quit semantics: decided on 21 October 2026, option A.** A clean, user-initiated quit of the dev app ends the whole `bun dev:desktop` session, including both tsdown watchers, Vite and turbo. Relaunching means running `bun dev:desktop` again. Options B (keep tooling, no auto relaunch) and C (keep today's auto relaunch, add a log line) were rejected because a closed app silently reappearing was the reported surprise, and B needs a new relaunch trigger that turbo's terminal UI makes awkward.
- **D2, ledger ownership: decided on 21 October 2026.** Crash-proof orphan cleanup belongs to the Rust background-service plan. Phases 1–4 do not depend on it. That plan is still Proposed and gated on its own dependency approval, so crash orphans remain possible until it ships.
- **PID reuse.** The Phase 2 snapshot can outlive a process, and the pid can be reused within the escalation window. `dev-supervise` already accepts this risk for the same window. The launcher now records each member's start time (`ps … lstart`) and never signals a pid whose start time changed, which closes this window for the launcher. `dev-supervise` still uses pid alone. The Rust plan's ledger must match start time and executable, never pid alone.
- **Intended side effect: the app tree is fully reaped.** A rebuild, Cmd+Q, dev Restart, fatal exit or crash SIGKILLs anything still in the dev app's process tree 4 s after the stop begins (sooner once the backend has drained). The tree includes processes started from in-app terminals, so a `nohup` job or a backgrounded `&` command launched there dies with the app, even though it ignores SIGHUP. Only a process that has left the tree before the last 1.5 s snapshot survives, for example one that double-forked away to init. Start long-running jobs from an outside terminal instead.
- **Concurrent teardown ordering (Phase 4).** Adapters may share resources, for example the OpenCode server manager used by OpenCode and Kilo. Concurrency must not reorder persistence relative to stops. Tests must cover both.
- **Budget drift.** Every budget lives in a different file. Phase 2 must document the full ordering next to `DEV_SUPERVISOR_GRACE_MS` and add a test asserting supervisor grace exceeds launcher shutdown. The 3 s per-adapter timeout bounds only how long stop-all waits: one ACP session stop can take 3 × 500 ms of capped cleanup, a 2 s SIGTERM window and a 1 s SIGKILL wait (about 4.5 s). The adapter finalizer's 4 s wait bounds it, and each capped cleanup step logs a warning.
- **No regression for the user's existing workflow.** A rebuild still relaunches the app after an expected stop. Only clean user quits and the dev Restart menu change behavior.

## Testing And Validation

**Unit tests:**

- `scripts/dev-supervise.test.ts`, extended for the shared tree walker and the new grace value.
- A new launcher state machine test covering snapshot, graceful exit, forced escalation, reparented survivors, clean quit for D1, the restart sentinel and Windows dispatch.
- ProviderService stop-all tests for concurrency, timeout and preserved persistence order.
- Cursor adapter stop tests.

**Focused server runs:**

```sh
bun run --cwd apps/server vitest run src/provider/Layers/ProviderService
bun run --cwd apps/server vitest run src/provider/Layers/Cursor
bun run --cwd apps/server vitest run src/provider/acp
```

**Manual reproduction, before and after each phase:**

```sh
bun dev:desktop
# open a Cursor thread and a Kilo thread, send a turn in each
touch apps/server/dist/bin.mjs        # repeat ten times, waiting for relaunch
# each stop prints "[dev-electron] stop graceful|forced ..." in the dev:electron output
ps -axo pid,ppid,command | awk '$2==1' | grep -E 'cursor-agent/versions/.*--trust acp|\.kilo/bin/kilo serve' | grep -v grep
```

**Required repository checks:** `bun fmt`, `bun lint`, `bun typecheck`, `bun run test`.

**Platform coverage:** macOS and Linux for Phases 1–4. Windows for the Phase 2 `taskkill` path and the Phase 3 restart sentinel.

## Acceptance Criteria

- Ten consecutive rebuild restarts with live Cursor and Kilo sessions leave no provider process with parent pid 1 from the dev checkout.
- Ctrl+C on `bun dev:desktop` leaves no process whose command contains the repo path.
- Cmd+Q on the dev app ends the whole dev session and returns the terminal to the prompt, with no bigbud dev process left running.
- The dev Restart menu produces exactly one supervised app instance.
- Packaged Quit and Restart behave exactly as before. Teardown completes within the Phase 4 budget when a provider child ignores SIGTERM.
- All files touched stay at or under 400 lines, and all repository checks pass.

**Still to verify live (as of 22 October 2026).** The live run covered three rebuild restarts and one Cmd+Q-equivalent quit on macOS. These remain open:

- Ten consecutive rebuild restarts with live Cursor and Kilo sessions that have each run a turn.
- The dev Restart menu: one supervised instance, relaunched through exit code 75, with the old tree reaped.
- Exit code 70: a fatal startup error or uncaught exception reaps the tree, leaves the launcher idle, and relaunches on the next rebuild.
- Exit code 69: a second dev instance blocked by the single-instance lock leaves the launcher idle without reaping.
- Windows: the `taskkill /T /F` stop, the exit codes, and Cmd+Q-equivalent quit ending the session through `taskkill` on dev-runner. Covered only by fake-host tests so far.

## Open Questions

- None open. Budgets accepted on 21 October 2026: 2 s per ACP child, 3 s per adapter in stop-all, 4 s launcher graceful stop and 8 s supervisor grace. The full ordering is documented in `scripts/lib/dev-electron-launcher.model.ts`.
