# Connection resilience: never-give-up reconnect and resume from the last applied event

**Date:** 21 October, 2026
**Status:** In progress. Steps 1 and 2 of the recommended order landed in `c9a9ca9d05` and `13b90621ba`. Step 3 (Phase 1b items 1 to 3) is implemented locally and awaiting review, 22 October 2026. Decisions D3 to D6 were taken on 21 October 2026. Phase 6 items 3 to 7 are implemented locally too; see [Phase 6](#phase-6-continue-running-turns-after-sleep-and-wake) and the [sleep and wake turn continuation plan](2026-10-22-sleep-wake-turn-continuation-plan.md).
**Owner:** bigbud web, server, desktop and native maintainers

## Summary

When the desktop app loses its WebSocket to the local server, the web client retries 8 times over about 3 minutes and then stops with "Retries exhausted trying to reconnect". While it is stopped, every RPC call fails and only a window focus, a browser `online` event, a desktop startup transition or the manual Retry button restarts it. The machinery to resume from the last applied event already exists and works on both delivery routes. What is missing is a reconnect policy that never gives up, faster and better-sourced triggers, and evidence of why connections drop in the first place.

This plan does five things:

- Adds observability so each disconnect has an attributed cause.
- Removes the server-side stalls that cause most real drops: synchronous SQLite work, synchronous SSH commands and frozen startups.
- Replaces the capped retry with an unbounded, jittered policy and wires operating-system sleep, wake and network signals into it.
- Hardens and tests the resume path so a reconnect always continues from the last applied event or a bounded baseline.
- Moves the pieces that can move to Rust: link health for the delivery supervisor, running the supervisor route in dev, and backend liveness through the Rust background-service plan.

## Related Work

- [Dev process leak and launcher plan](2026-10-21-dev-process-leak-and-launcher-plan.md). Same investigation. Its Phase 3 makes dev Electron quits predictable, which removes one class of apparent disconnects.
- [Optional Rust-owned background service](2026-10-15-rust-background-service-plan.md), Proposed. Owns backend lifetime. Phase 5 of this plan depends on it for backend liveness that survives a crash.
- [Thread auto-resume plan](2026-09-10-rust-coordinated-thread-auto-resume-plan.md), Proposed. Its Phase 3 already specifies Electron suspend and resume listeners and durable retry interest. This plan implements the transport part of that phase, and Phase 6 here delivers its sleep-and-wake slice. Neither may duplicate its reconciliation coordinator.
- [Desktop delivery supervisor production plan](2026-08-27-desktop-delivery-supervisor-production-plan.md), Implemented locally. Defines the Rust sidecar this plan extends.
- [Dead-thread recovery plan](2026-10-15-dead-thread-recovery-plan.md), Implemented. Covers provider-session recovery after a backend restart. This plan does not change it.
- Bigbud note or Kanban card: none identified. The work came from a direct request in a chat thread.

## Problem

### What the user sees

The app shows "Disconnected from bigbud, Reconnecting in Ns, Attempt k of 8", then either "Reconnected" or, after roughly 3 minutes, "Retries exhausted trying to reconnect" with a Retry button. Until Retry succeeds, sends and every other action fail.

### Observed facts

- **Retry policy.** `WS_RECONNECT_MAX_RETRIES = 7` gives 8 attempts with delays of 1, 2, 4, 8, 16, 32, 64 s capped at 64 s (`apps/web/src/rpc/wsConnectionState.ts:10–14`, `:187–197`). The Effect socket protocol consumes that schedule (`apps/web/src/rpc/protocol.ts:136–144`). After it is spent, the transport reports `exhausted`.
- **Exhausted blocks everything.** `WsTransport.request` and `requestStream` throw `WsProtocolRecoveryExhaustedError` while exhausted (`apps/web/src/rpc/wsTransport.ts:120–145`). Subscriptions park until an explicit recovery (`:165–170`).
- **A second budget exists.** Three protocol-level failures inside one session window also mark the transport exhausted (`wsTransport.ts:339–366`). Protocol failures are RPC defects or write failures, not socket drops.
- **Restart triggers after exhaustion** are window focus, the browser `online` event, desktop startup transitions and manual Retry (`WebSocketConnectionSurface.coordinator.tsx`, `WebSocketConnectionSurface.logic.ts:61–85`, `DesktopBackendStartupCoordinator.tsx:99–111`). There is no operating-system sleep, wake or network-change signal from the Electron main process.
- **Dead-socket detection.** The renderer pings every 5 s with a 15 s timeout and reconnects after 3 consecutive failures, unless inbound events kept arriving (`apps/web/src/rpc/wsHeartbeat.ts`, `WebSocketConnectionSurface.heartbeat.ts`). A silently dead socket can take about 60 s to notice. The server sends no WebSocket ping frames and has no idle timeout.
- **Resume from the last applied event already exists.** The client persists a consumer id and applied sequence in `localStorage` (`apps/web/src/rpc/orchestrationDeliveryCursor.ts`) and sends both on every subscribe (`apps/web/src/rpc/wsNativeApi.ts:50–51`, `:85–87`). The server opens a delivery session at that sequence on both the direct route used in dev and the supervisor route used in packaged builds (`apps/server/src/ws/wsRpcHandlers.orchestrationServer.ts:294–307`, `desktopSupervisorDelivery.session.ts:260–271`, `:348–361`). Replay pages 1 000 events at a time up to 4 000 events, then requests a baseline instead (`desktopSupervisorDelivery.session.replay.ts`, `desktopSupervisorConfig.ts:8`). A compacted gap also requests a baseline. The client answers a baseline with a bounded bootstrap under a 60 s deadline against the server's 65 s gate (`-__root.delivery-routing.ts:12–15`).
- **What replays and what does not.** Streaming assistant text is persisted as `thread.message-sent` events with a `streaming` flag, so it replays and coalesces (`-__root.orchestration-events.ts`). Thinking deltas are ephemeral and are cleared on resubscribe by design (`-__root.logic.tsx:216–219`). Terminal output recovers from a snapshot plus acknowledgements. Pending sends are persisted server-side.
- **Turns are not tied to the socket.** Nothing in `apps/server/src/ws` interrupts a turn when a socket closes. A drop costs the user visibility, not work. A backend restart does end turns, which the dead-thread recovery plan handles.
- **Churn is real in dev.** Server traces for 21 October show 151 domain-event subscriptions, many lasting under 30 s, with bursts such as 16:18:29, 16:18:32, 16:18:35 and 16:18:38. Every one ended as `Interrupted`, meaning the client closed it. Pairs a few seconds apart are the main window and the floating assistant, which are two consumers. Ping requests are not traced, so the cause of each drop cannot be read from server traces. The renderer logs close codes only to its console.
- **Rust today.** `crates/bigbud-desktop-supervisor/src/connection.rs` defines a `TransportHealth` state machine with heartbeat, suspect, reconnect and bootstrap transitions. It is exported and unit tested but never used (`lib.rs:8` is the only reference). The supervisor binary runs an acknowledgement watchdog only. The supervisor route is selected only when `BIGBUD_DESKTOP_PACKAGED=1` or `BIGBUD_DESKTOP_SUPERVISOR_ENABLED=1` (`desktopSupervisorConfig.ts:32–46`), so dev never exercises the Rust path.
- **Dev restarts.** In dev every rebuild relaunches Electron, which reloads the window rather than reconnecting. Those are not reconnects and are covered by the dev launcher plan.

### Why the server drops: root causes from 21 October 2026

The server traces record every WebSocket as an `http.server GET /ws` span, so each socket's lifetime and end can be reconstructed. Today's dev session had 228 sockets across 6 server starts. 36 lived under 5 s, 87 lived 5 to 60 s and only 27 lived over 10 minutes. The causes fall into four groups.

1. **Renderer page reloads, not server drops (dev only).** About 20 drop clusters today ended 3 sockets at once and were followed within 6 s by `plugins.refreshCatalog`, which runs exactly once per renderer mount (`apps/web/src/components/plugins/PluginUpdateToastCoordinator.tsx:16–23`). Those are Vite full reloads or Electron relaunches after code changes. The three sockets are the main window, the floating assistant and the compact chat. Each reload re-bootstraps the whole UI but is not a connection failure. They inflate the churn numbers and must be tagged so they stop counting as disconnects.

2. **The server event loop freezes on synchronous work.** The SQLite client is `node:sqlite` `DatabaseSync` (`apps/server/src/persistence/NodeSqliteClient.ts:7`). Every query runs on the main thread. Today's 296 traced `sql.execute` spans had a median of 370 ms and a 99th percentile of 5.9 s. 32 took over 1 s and 10 took over 5 s. The usage-summary query with the `historical_requests` common table expression (`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.usage.effective.ts`) took 5 to 7 s on 10 of its 83 calls. Two one-off migrations froze the process completely: migration 96 for 94 s at 12:10, and migration 78 for 478 s at 18:13, during which zero spans completed for 8 minutes and every in-flight span, including eight discovery walks and the baseline verification, reported the same 481 s. While the loop is frozen, pings time out, the renderer's heartbeat gives up after 3 failures, and the drop is attributed to the network.

   The same freeze comes from `spawnSync`. SSH password unlock runs `ssh` synchronously with no timeout (`apps/server/src/ssh/sshSession.ts:31–38`, `:185`), and SSH verification runs `ssh-add -l` synchronously (`sshVerification.ts:27–34`, `:50`). At 15:00:43 an unlock blocked the server for 75 s. Every unrelated span in flight, including terminal polls, measured 75 s, and when the loop resumed the server answered 14 queued upgrade requests from the same renderer with status 499 because the client had already abandoned each one. That is a reconnect storm caused by a frozen server, and it shows the renderer opens a new socket attempt per retry without checking whether the previous upgrade is still pending.

3. **Slow and frozen startups look like outages.** The dev database is 2.86 GB with 485 269 events. Startup runs migrations inside one synchronous transaction, verifies the projection baseline by paging through canonical history (`ProjectionPipeline.baseline.workspace.ts:279–296`), and failed that verification twice today with `retained history starts after <cursor>`. The desktop's startup deadline is 10 minutes (`backendStartupState.ts:10`), so the 8-minute migration nearly produced a `timedOut` state. Startup also launches 8 recursive directory walks for provider discovery, repeated every 5 minutes all day (1 097 walks, 2.6 h of wall time) over roots such as `~/.codex` at 5.0 GB and `~/.copilot`, plus four Cursor model-capability probes that spawn Cursor agents and failed after 16 s on every start.

4. **Nothing watches the server's own health.** There is no event-loop lag metric, no server-side WebSocket keepalive and no "server stalled" signal. A frozen server and a dead network are indistinguishable to the renderer, so both get the same toast and the same 3-minute give-up.

What this means for the plan: the reconnect policy fixes the symptom, and it is still needed, but most real drops today were the server freezing itself. Phase 1b removes those freezes. The packaged app has the same synchronous driver and a user with a 16 GB state database, so the stalls are worse there, not better.

### What cannot move to Rust, and what could

The WebSocket client lives in the renderer. Rust cannot own that socket. What Rust can own is link health for the supervisor, backend liveness and restart, and cursor authority that outlives a backend crash.

A larger option was considered on 21 October 2026: a Rust-owned socket gateway, where the renderer connects to a Rust process that terminates the WebSocket and proxies to the TypeScript server. It is assessed in Risks And Decision Gates (D7). The conclusion is that a Rust socket only adds resilience once Rust also owns the backend's lifetime, which is the Rust background-service plan. Until then a Rust socket beside a server that can still freeze itself changes the error message, not the outcome. The root causes in this plan are removed by Phases 1b, 1 and 2 regardless of which process owns the socket.

## Goals

- A disconnect while the app is open always ends in a reconnect without user action, as long as a server exists to reach.
- Reconnect starts within 5 s of a wake from sleep, a network change or a backend becoming ready.
- A silently dead socket is detected within 20 s under normal load, without false positives while events are flowing.
- Every reconnect resumes from the last applied event, or from a bounded baseline when replay is unavailable, on both windows.
- Each disconnect has an attributed cause in diagnostics, and renderer reloads are not counted as disconnects.
- No synchronous database or child-process work blocks the server's main thread for more than 50 ms in steady state. Migrations and baseline verification run with progress under the existing `upgrading` startup status.
- Dev exercises the same delivery route and Rust supervisor as packaged builds.
- After the laptop sleeps during a running turn and wakes, the app reconnects within seconds and the agent continues the turn without user action whenever that is provably safe. When it is not safe, the thread says exactly what is uncertain instead of silently failing.

## Non-Goals

- No change to canonical event semantics, acknowledgement rules or the controlled-fallback contract.
- No replay of possibly accepted work. The auto-resume plan's invariant, reconcile before continuing, stays in force.
- No background operation after quit. That is the Rust background-service plan.
- No change to SSH remote project Reconnect, which is a service restart with its own plan.
- No change to mobile delivery beyond what the shared transport changes imply.

## Current State

| Concern                           | Where                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Retry constants and state         | `apps/web/src/rpc/wsConnectionState.ts`                                                                      |
| Socket layer and schedule         | `apps/web/src/rpc/protocol.ts`                                                                               |
| Transport sessions and exhaustion | `apps/web/src/rpc/wsTransport.ts`, `wsTransport.session.ts`                                                  |
| Heartbeat                         | `apps/web/src/rpc/wsHeartbeat.ts`, `components/WebSocketConnectionSurface.heartbeat.ts`                      |
| Triggers and toasts               | `components/WebSocketConnectionSurface.coordinator.tsx`, `.logic.ts`, `DesktopBackendStartupCoordinator.tsx` |
| Consumer cursor and subscription  | `apps/web/src/rpc/wsNativeApi.ts`, `orchestrationDeliveryCursor.ts`, `routes/-__root.logic.tsx`              |
| Replay and baseline recovery      | `routes/-__root.recovery.ts`, `-__root.delivery-routing.ts`, `-__root.bounded-bootstrap.ts`                  |
| Server delivery sessions          | `apps/server/src/ws/wsOrchestrationDelivery.ts`, `desktop-supervisor/desktopSupervisorDelivery*.ts`          |
| Rust supervisor                   | `crates/bigbud-desktop-supervisor/src/{main,connection,owner_session}.rs`                                    |
| Desktop backend state             | `apps/desktop/src/backend/backendManager.ts`, `backendStartupState.ts`                                       |

## Phases

### Phase 0: Attribute every disconnect

**Goal.** Know why connections drop before changing policy.

1. Add an event-loop lag monitor to the server using `perf_hooks.monitorEventLoopDelay`. Export the 99th percentile and maximum per 10 s window into the trace, and emit a `server.stalled` lifecycle event over the existing server lifecycle stream when a single stall exceeds 1 s. Log which span was running when the stall began.
2. Tag renderer page loads. On its first connect after a navigation, the renderer sends `reason: "page-load"` so a reload is never counted as a disconnect in diagnostics or in the toast logic.
3. Add a `wsConnectionDiagnostics` report RPC. On each close, error, heartbeat failure, protocol failure and reconnect success, the renderer sends the close code and reason, the trigger kind, attempt count, time since the last inbound event and the consumer id. The server logs them under one span name and keeps a bounded ring in memory for the diagnostics view.
4. Trace the `serverPing` RPC so ping latency is visible next to subscription lifetimes.
5. Record the reason a delivery session ends on the server: client close, overflow, handoff ended, or server shutdown.
6. Add a connection section to the existing diagnostics surface showing the last 20 transitions.

**Exit criteria.** One day of dev use yields a per-cause count of disconnects. The plan's budgets in later phases are tuned against that data rather than guessed.

### Phase 1: Never give up, with better triggers (web)

**Goal.** The transport keeps trying for as long as the app is open.

1. Replace `Schedule.recurs(WS_RECONNECT_MAX_RETRIES)` with an unbounded schedule: exponential from 1 s to a 30 s cap with full jitter. Keep `reconnectMaxAttempts` only for the toast label, which becomes "Attempt k" after the old cap.
2. Make `exhausted` a UI state, not a transport state. Requests fail fast with a clear transport error while disconnected instead of throwing `WsProtocolRecoveryExhaustedError` forever. Subscriptions keep waiting on the live reconnect operation. Decision (21 October 2026): a request made while an upgrade is in flight (link `connecting`) is queued instead of failing fast, because that attempt usually opens within moments and failing it would turn every routine reconnect, including the first connect after page load, into spurious user-visible request errors. The wait is not bounded by the transport: the 30 s open timeout bounds each upgrade attempt, not the request, and with `retryTransientErrors` a failed upgrade is a `SocketOpenError` that effect's `RpcClient` retries without failing queued requests. A queued request therefore waits across retries until a later socket opens, or until its own opt-in request deadline (for example the 15 s config read or the 10 s heartbeat probe) expires.
3. Turn the three-failure protocol budget into a sliding window. Repeated protocol defects within 30 s back off harder but never stop.
4. Add immediate retry triggers: `visibilitychange` to visible, the desktop power resume and network change signals from Phase 2, and the backend `ready` transition for any previous state, not only `timedOut` and `failed`.
5. Tighten dead-socket detection: 5 s interval, 10 s timeout, 2 consecutive failures with no inbound activity. Keep the existing rule that inbound activity resets the failure count, so a busy server never trips it.
6. Preserve the existing toast semantics: blue while reconnecting, green on success, red only when the backend reports a failed startup.

**Why not keep a cap.** A capped policy only helps if a stuck client would otherwise waste resources. Here the server is local, the backoff is bounded and the cost of giving up is a dead-looking app. The Restart hatch remains available for real faults.

**Exit criteria.** Tests prove unbounded retry with jitter bounds, fail-fast requests while disconnected, and trigger handling. The "Retries exhausted" toast no longer exists.

### Phase 1b: Remove server-side stalls (server)

**Goal.** The server never freezes its own event loop long enough to lose a connection.

1. **Move SQLite off the main thread.** Run `node:sqlite` inside a `worker_threads` worker and expose it through the existing Effect SQL client as an asynchronous request and response bridge. Keep the single-connection and WAL semantics. Phase this in: first migrations and baseline verification, then the read-model and snapshot queries, then everything. Measure with the Phase 0 lag monitor at each step.
2. **Make heavy migrations visible and bounded.** Migrations already run under the `upgrading` startup status. Batch migration 78's event inserts and any future backfill in chunks with progress written to the startup status pipe, so the desktop shows "Updating local data, 42 %" instead of a frozen app. Add a fixture test that runs the migration set against a copy of a 3 GB database and asserts the main thread never blocks over 1 s.
3. **Replace `spawnSync` in the SSH paths** with asynchronous `spawn`, an explicit `ConnectTimeout`, and a 20 s overall deadline. Cover password unlock, control-master setup and the `ssh-add -l` probe. Audit the remaining `spawnSync` sites: `utils/processStartToken.ts`, `utils/machineIdentity.ts`, `codex/codexVersionCheck.ts`, `provider/Layers/Pi/RpcProcess.ts` and `provider/codexAppServer.ts`. Keep only those that run once at startup with a bounded command, and give them timeouts.
4. **Bound the usage-summary query.** Index or materialize the `historical_requests` aggregate so it stays under 100 ms on a 3 GB database, or compute it incrementally from new events.
5. **Calm provider discovery.** Walk discovery roots on watcher events and on explicit refresh only, with the 5-minute fallback rescan kept for platforms without a watcher. Exclude obviously irrelevant subtrees before the recursive read instead of after it. Make the Cursor capability probes lazy, so they run when Cursor is first used rather than on every start.
6. **Fix the reconnect storm.** The renderer must keep a single in-flight upgrade per transport session and must not open a new socket while the previous one has neither opened nor closed, so a frozen server sees one pending upgrade rather than 14.

**Why a worker thread and not Rust for storage.** TypeScript owns canonical SQLite by the architecture contract in `docs/CONTEXT.md`, and the Rust plans keep it that way. A worker thread removes the freeze without changing ownership. A Rust storage engine is a separate product decision (D6) and would not land sooner.

**Exit criteria.** The lag monitor shows no main-thread stall over 50 ms during an hour of normal dev use with a 3 GB database. Startup on that database shows progress and never exceeds the desktop deadline. SSH unlock against an unreachable host fails within its deadline while the UI stays responsive.

**Status, 22 October 2026: items 1 to 3 implemented, not yet committed.**

- **Item 1, SQLite worker.** The server's writable state database runs on a `worker_threads` connection under Node: `apps/server/src/persistence/NodeSqliteClient.worker*.ts` and `NodeSqliteWorker.ts`, enabled by `makeSqlitePersistenceLive` in `Layers/Sqlite.ts`. This covers migrations, baseline verification, read-model, snapshot and all runtime queries. Three cases stay on the main thread:
  - **The Bun runtime.** `bun dev:server` runs `src/bin.ts` under Bun, which loads `@effect/sql-sqlite-bun` instead of `NodeSqliteClient`, so it has no worker.
  - **The read-only CLI connection** (`makeSqliteReadOnlyPersistenceLive`, used by `cli/cli.ts`).
  - **In-memory test databases.**

  The desktop and packaged builds run `dist/bin.mjs` under Electron's Node, so the worker applies there. The hour-of-dev-use exit check must therefore run under the desktop app, not `bun dev:server`. `BIGBUD_SQLITE_WORKER=0` forces everything in-process as the fallback, and `BIGBUD_SQLITE_WORKER=all` forces everything into a worker so suites can be run against it. Single-connection, WAL and transaction semantics are unchanged: the Effect SQL client's semaphore and acquirers are byte-identical to before, and the worker handles one statement at a time in arrival order. The bridge contract (`NodeSqliteClient.worker.bridge.ts`) is:
  - **Failures:** a crash, an exit, a failed open, or an open that has not finished within 30 s surfaces as a `ConnectionError`. Pending and later statements fail at once. There is no automatic restart.
  - **Close:** close waits for the thread to exit, bounded at 5 s for the close acknowledgement plus 10 s for exit.
  - **Interruption:** an interrupted caller does not cancel its statement. The statement still finishes in the worker, its result is discarded, and later statements queue behind it, because `node:sqlite` cannot interrupt a running statement from another thread.

- **Item 1, stopping point and evidence.** A first slice kept runtime queries in-process because 4 of 6 tests in `integration/providerRuntimeIngestion.periodic.integration.test.ts` failed with the worker: `WaitForTimeoutError` in "repairs a lost terminal state without user action" and in "leaves state unchanged after one listSessions failure…", a 60 s timeout in "…listing times out", and `expected ['queued-a','queued-b','queued-c'] to deeply equal ['queued-c']` in "flushes only the prompts captured before interruption". Root causes, verified on 22 October:
  - **Harness clock:** the harness advances a `TestClock` while the repair fiber is still waiting on database I/O, so the fiber's next sleep is registered after the clock moved and never fires. The harness now waits for worker idle (`waitForNodeSqliteWorkersIdle`) before and after each advance.
  - **Transient queue state:** two tests asserted a state that held only while follow-up delivery was unfinished. With 200 ms of real time after each clock advance, both fail the same way on the in-process driver (`BIGBUD_SQLITE_WORKER=0`), so the worker is not the cause.
    - **"preserves an interrupt flush intent…" was a test artifact.** It removed the provider session before the interrupt reactor had run. The reactor's own 100 ms recheck (`ProviderCommandReactorHandlers.session.ts`, `processTurnInterruptRequested`) then settled the stale turn and continued with `queued-a` in the first clock advance, so the periodic grace the test names was never reached. It only passed while that recheck was parked on the `TestClock`. The test now waits for the interrupt to reach `waiting-for-settlement` before it removes the session, and it asserts after 200 ms of real time. It runs on the worker.
    - **"flushes only the prompts captured…" exposed a production race. Fixed on 22 October 2026 with a durable pending-start gate; the test no longer has the `TRANSIENT_QUEUE_STATE` in-process pin and runs on the worker.** The interrupt continuation flushes `queued-a` and `queued-b` and requests their turn. Starting a session for that turn writes session `starting`, then `ready`. The `ready` triggers a lifecycle flush (`orchestration/QueuedPromptFlush.logic.ts`, `makeLifecycleQueuedPromptFlushCommand`). The idle check (`orchestration/ThreadDispatchSafety.logic.ts`, `isThreadConfirmedIdleForDispatch`) does not see a turn that is requested but not yet bound, so `queued-c` is flushed and sent too.
      - Event order in the repro: 12 `turn-start-requested` (a+b), 14 session `starting`, 15 session `ready`, 16 `queued-prompts-flushed ["queued-c"]` with a `queue-flush:` command ID, 18 `turn-start-requested` (c), 19 the a+b turn bound.
      - Minimal repro: that test with `yield* Effect.sleep("200 millis")` after each `advanceClock`, on either driver. It ends with an empty queue and both inputs sent to the adapter.
      - **Fix: durable pending-start gate.** `thread.turn-start-requested` now records `pendingTurnStart` on the thread (message ID, request time, event sequence). It is persisted in `projection_threads.pending_turn_start_json` (migration 136), and the in-memory and SQL projectors share one transition, `orchestration/PendingTurnStart.logic.ts`. `isThreadTurnDispatchBlocked` treats the thread as busy while the gate is set, so every flush trigger and every direct `thread.turn.start` waits.
      - **Exits.** The gate clears when the turn binds (a session with an active turn), when the provider accepts the message and is already idle again (`text-generation.user-turn-bound` with `providerIdle`, recorded after the running stamp and treated as a lifecycle flush trigger), when that message's start fails (`thread.turn-start-failed` now carries `messageId`), when a busy refusal re-queues the message, when the session stops or errors, and when the user stops the session. Reconciliation no longer writes `stopped` for a gated thread whose provider session is missing, because that is the session still being started.
      - **Restart.** A gate found when the engine loads its state belongs to the previous process. That start is never resumed and may already have reached the provider, so the engine settles it as a stopped session rather than resending it, and the queue flushes behind it. Starts committed during startup but before the provider command reactor subscribes (the engine's queue recovery flush, and lifecycle flushes after ingestion's startup reconciliation) are found by sequence after subscribing and re-driven; turn-start handling is deduplicated by command, so each runs once.
      - **Last resort.** A reactor watchdog fails a start that has neither bound nor failed within 10 minutes of first being seen. "Send now" may replace a start that has held the queue for 2 minutes. A redelivered busy refusal is re-queued ahead of later prompts, behind any prefix an interrupt or control operation already captured.
      - **Tests.** `orchestration/QueuedPromptFlush.pendingTurnStart.test.ts` (race and every exit), `orchestration/PendingTurnStart.logic.test.ts`, `Layers/OrchestrationEngine.pendingTurnStart.test.ts`, `Layers/ProviderCommandReactor.pendingTurnStart.test.ts`, the watchdog, backstop and reconciliation tests, `integration/pendingTurnStart.restart.integration.test.ts` (restart with the real reactor), and two periodic integration tests: the original repro, unpinned on the worker, and a start held open across periodic passes.
        With these changes the runtime connection moved to the worker. The persistence, orchestration and integration suites pass.
- **Item 2, chunked migrations.** Migrations 078 and 057 scan `orchestration_events` in 25 000-sequence chunks (`Migrations/EventSequenceChunks.ts`), with results equal to one full scan; there are chunk-boundary tests for both. Progress across all pending migrations reaches the desktop as `{"status":"upgrading","progress":N}`, and the toast shows "Updating local data, N%". A fresh database reports no progress, and projection replay's plain `upgrading` record clears the percent. The fixture `persistence/Migrations.lag.test.ts` uses 150 000 generated events instead of a 3 GB copy. It asserts no main-thread gap over 1 s, at least 4 chunk progress steps, and that the startup layer migrates on the worker. At this size the worker's max gap is about 11 ms against about 199 ms in-process.
- **Manual 3 GB benchmark.** Copy the database with `sqlite3 <state.sqlite> ".backup /tmp/copy.sqlite"`, then run `BIGBUD_SQLITE_LAG_BENCHMARK_DB=/tmp/copy.sqlite bun run --cwd apps/server vitest run src/persistence/NodeSqliteClient.lag.benchmark.test.ts`. Add `BIGBUD_SQLITE_WORKER=0` for the in-process baseline. Results on the 2.86 GB dev database, as max main-thread stall in-process then on the worker: migration 078 162 ms (3 666 ms with a cold cache) then 21 ms; migration 057 1 074 ms then 22 ms; usage entries 450 ms then 21 ms; `getSnapshot` 133 ms then 111 ms. 21 ms is the sampler's resolution. The remaining `getSnapshot` stall is JavaScript assembly of the read model, not SQL.
- **Bootstrap replay on the worker.** The benchmark's `bootstrapReplay` step rewinds every projector cursor by 5 000 sequences inside a rolled-back transaction, then runs the startup projection bootstrap. It first drops events of threads purged since then, leaving 2 377 events × 11 projectors. Two runs each on the 2.86 GB copy:

  | Driver     | Duration       | Max main-thread stall |
  | ---------- | -------------- | --------------------- |
  | In-process | 42.6 s, 43.1 s | 246 ms, 267 ms        |
  | Worker     | 46.5 s, 46.7 s | 25 ms, 26 ms          |

  The worker costs about 8 %, not enough to justify batching statements inside it. The replay is slow on both drivers, about 18 ms per event, so that cost is SQLite work in the projectors, not bridge round trips. It is a separate follow-up.

- **Item 3, SSH.** Password unlock, the control-master check, the `ssh-add -l` probe, `ssh-agent -s` and `ssh-add` all run through the async runner `ssh/sshLocalCommand.ts`, with `ConnectTimeout=10` where a connection is opened and one 20 s deadline per unlock. `assertSshExecutionTargetReadyAsync`, with a 10 s deadline, now serves `verifySshExecutionTarget`, `runSshCommand`, terminal cwd resolution, Pi RPC start, OpenCode remote server start (`provider/Layers/Opencode/ServerManager.child.ts:123`), remote-agent connections and update credential checks. Windows `taskkill` is asynchronous everywhere through `utils/killProcessTree.ts`, and `processStartToken` has a 2 s timeout.
- **Synchronous SSH sites that remain**, each bounded by a 5 s timeout per probe:
  - The remote Codex version check is wired to the async path, with `ConnectTimeout` and a 20 s deadline: `codex/codexAppServerManager.startSession.ts` awaits `startCodexAppServerProcessAsync(...)` under a per-thread pending-start guard (`codex/codexAppServerManager.pendingStarts.ts`), so a manager `stopSession` or `stopAll` during the check cancels the start and the remote app-server is never spawned. Stops that act only on sessions they can see, such as thread-subtree deletion, still miss a start in that window.
    - **Wiring it opens a stop-during-start race.** The `await` runs before `ops.sessions.set` (`:168` today). A stop that arrives during the check, which can take up to 20 s, finds no session to stop, and the remote app server then starts anyway. The wiring needs a stop check after the `await`, or a placeholder session registered before it.
  - The synchronous `-O check` in `buildSshPasswordSessionTransportArgs` is skipped for 10 s after any successful check.
  - `machineIdentity` (5 s, once per process) and `codexVersionCheck` (4 s, cached per binary) stay synchronous.
- **Still open from Phase 1b:** items 4 and 5, and the `getSnapshot` main-thread assembly cost.

### Phase 2: Operating-system signals from Electron main (desktop)

**Goal.** Sleep, wake, lock, unlock and network changes reach the renderer within a second.

1. In the Electron main process, subscribe to `powerMonitor` `suspend`, `resume`, `lock-screen` and `unlock-screen`, and poll `net.isOnline()` on a coarse interval plus on resume. Publish coalesced hints over the existing desktop bridge next to backend startup state.
2. In the renderer, `resume`, `unlock-screen` and online transitions call `reconnectNow`, which bypasses the current backoff wait. `suspend` invalidates the heartbeat so a stale probe cannot count as a failure.
3. On resume, the backend manager probes the backend port once and republishes `ready` or schedules a restart, so the renderer gets a definite signal instead of discovering a dead backend through ping timeouts.
4. Platform notes. All three events exist on macOS and Windows. On Linux, `suspend` and `resume` depend on a logind D-Bus session and `lock-screen` is unsupported, so Linux relies on resume plus the online poll. Record this in the diagnostics so a missing signal is visible.

**Dependency.** Aligns with the auto-resume plan's Phase 3 item 1. Implement once, here, and reference it from that plan.

**Exit criteria.** Closing the lid for 10 minutes and opening it reconnects within 5 s on macOS and Windows, and within one poll interval on Linux.

### Phase 3: Resume correctness under every drop (web and server)

**Goal.** Every reconnect continues from the last applied event or a bounded baseline, and tests prove it.

1. Add integration tests for: drop mid-stream, where replay restores partial assistant text and the live tail; drop with more than 4 000 pending events, where a baseline is requested, acknowledged and followed by live delivery; a compacted gap; a backend restart mid-turn, where dead-thread recovery and UI reconciliation both run; and two consumers, main window and floating assistant, reconnecting at different cursors.
2. Make the replay budget and page size configurable per route, and raise the budget on the direct route where the whole replay stays in the server process. Record when a baseline was chosen and why.
3. Persist the applied cursor on every acknowledged batch, not only on a timer, so a renderer crash loses at most one batch.
4. Ensure a reconnect after a server restart with a new `serverEpoch` still replays from the persisted sequence, since sequences are global in SQLite, and that baseline recovery is used only when the store reports a gap.
5. Clear ephemeral thinking deltas on resubscribe, as today, and show a short "catching up" state while replay is applying so the user can tell a replay from a frozen stream.

**Exit criteria.** The listed scenarios pass in Vitest and the browser suite. Manual checks with `kill -STOP` on the server for 30 s, a Wi-Fi toggle and `kill -9` on the server each end with the thread view matching the server's read model.

### Phase 4: Rust link health and the supervisor route in dev

**Goal.** The Rust supervisor owns the health of its link, and dev exercises it.

1. Wire `TransportHealth` into `owner_session.rs` and the main loop. The supervisor sends heartbeats, enters `Suspect` after silence, requests reconnect after the reconnect threshold, and requests bootstrap when replay is unavailable. Expose its state in the `MetricsSnapshot` frame so the server's lifecycle messages can show "supervisor suspect" before a restart.
2. Have the server's delivery coordinator consume the new state: a `Suspect` link emits a `reconnecting` lifecycle to the renderer early, and a `ForceReconnect` starts the existing bounded restart instead of waiting for an acknowledgement timeout.
3. Enable the supervisor route in dev by default. The dev launcher already builds the crate for the system monitor (`apps/desktop/scripts/dev-system-monitor.mjs`). Pass the debug binary as `BIGBUD_DESKTOP_SUPERVISOR_BINARY` and set `BIGBUD_DESKTOP_SUPERVISOR_ENABLED=1` in dev, with `0` as the opt-out. Dev then runs the same delivery path as packaged builds, which is the only way the Rust reconnect work gets daily use.
4. Keep the wire protocol unchanged. New fields are additive and the server tolerates their absence.

**Exit criteria.** Rust unit tests cover the wired transitions. Server tests cover early `reconnecting` on `Suspect`. Dev logs show the `supervisor` route. All Rust checks pass: `cargo fmt --all --check`, `cargo clippy --locked --workspace --all-targets -- -D warnings`, `cargo test --locked --workspace`.

### Phase 6: Continue running turns after sleep and wake

**Goal.** Closing the laptop during a running turn and reopening it resumes the work automatically when safe. Added on 21 October 2026 at the user's request.

**Status, 22 October 2026: items 3 to 7 implemented locally, not committed,** by the [sleep and wake turn continuation plan](2026-10-22-sleep-wake-turn-continuation-plan.md). See its [Implementation notes](2026-10-22-sleep-wake-turn-continuation-plan.md#implementation-notes). Item 1's probe runs are still to do. They gate the exit criteria and keeping automatic continuation on by default. Item 2 was done on 22 October 2026.

**What happens today.** Sleep freezes the server and every provider process. Nothing is lost locally, but an in-flight request to the provider's cloud model is usually cut during a longer sleep. Some providers retry and continue; others end the turn with an error, which bigbud shows as failed or interrupted until the next user message. Remote SSH work keeps running on the remote host during sleep and needs reattachment, not a restart.

**Relationship to the auto-resume plan.** The [thread auto-resume plan](2026-09-10-rust-coordinated-thread-auto-resume-plan.md) already designs this machinery: durable recovery intent per accepted turn, a `may-have-been-sent` marker persisted before each provider call (its Phase 1 item 3), suspend and resume handling and remote reattachment (its Phase 3), and one shared continuation decision policy per provider (its Phase 5 item 6). This phase delivers the sleep-and-wake slice of that plan under its invariant, **reconcile before continuing; never blindly replay potentially accepted work**. It must not build a second recovery coordinator, a second retry loop, or a second persistence model.

1. **Measure each provider.** For every registered provider, run a turn that is streaming model output and a turn that is running a tool, sleep for 1, 10 and 30 minutes, wake, and record what happens: continues, retries internally, errors, or hangs. Record installed SDK and CLI versions. Do the same for one SSH remote project. Store the results as a conformance table linked from this plan and from the auto-resume plan. Dependency: Phase 2 for the wake signal. Procedure, kit (`scripts/sleep-wake-probe.ts`) and results table: [Sleep and wake provider conformance](../research/Sleep%20and%20wake%20provider%20conformance/README.md).
2. **Revalidate the auto-resume plan** against current `main`. It was written against an older commit and is still Proposed. Update its file references and confirm which of its Phase 1 interfaces are needed for this slice.
3. **Persist the minimum durable intent for this slice.** Following the auto-resume plan's Phase 1 items 1 to 3: a recovery intent per accepted turn and the delivery progress states up to `may-have-been-sent` and `provider-acknowledged`, written before the external call. App quit and `stopAll` suspend intent rather than revoke it; an explicit user Stop revokes it.
4. **Classify turn failures caused by suspend.** A turn that failed with a transport or connection error between a `suspend` and a `resume` signal from Phase 2, or within a short window after `resume`, is classified as `interrupted-by-sleep`, not as a provider failure.
5. **Continue safely.** Apply the auto-resume plan's decision policy to `interrupted-by-sleep` turns:
   - The provider is still running the turn: attach and observe.
   - The turn finished during or after sleep: ingest and settle.
   - The model request was cut and no tool action was in flight: continue automatically, once, as a new linked continuation with the original objective and completed work. Re-asking the model has no side effects.
   - A tool action such as a shell command or file edit may have been mid-flight: do not continue. Show a precise resolution prompt in the thread naming the uncertain action.
   - The provider cannot be reached yet, for example no network: keep the intent and retry when the network signal arrives.
6. **Reattach remote work.** For SSH remote projects, reattach to the original remote process and retrieve its output using the remote agent's retained operation journal, as the auto-resume plan's Phase 3 items 4 and 5 describe. Never start a fresh remote run while the original may still be alive.
7. **Show it.** While recovering, the thread shows a blue "Resuming after sleep" state; on success it disappears; on an uncertain tool action it shows the resolution prompt. Respect the toast and status colour rules.

**Decisions, 22 October 2026.** Recorded in full under the auto-resume plan's [Open Questions](2026-09-10-rust-coordinated-thread-auto-resume-plan.md#raised-by-the-22-october-2026-revalidation) and [research proposals](2026-09-10-rust-coordinated-thread-auto-resume-plan.md#proposals-from-the-durable-connections-research-for-decision). In short:

- `ProviderTurnSupervisor` grows into the single recovery coordinator.
- Electron main sends suspend and resume to the server directly; the server's clock-gap detection backs it up.
- `interrupted-by-sleep` is a recovery status on the intent.
- Dead-thread turn-start recovery stays a separate path for this phase; the coordinator absorbs it later in the full auto-resume work.
- A backend restart after wake is treated as uncertain and shows the resolution prompt.
- A provider that continues a turn on its own, such as OpenCode V2, is allowed to; bigbud observes it, does not continue it again, and the thread shows that the provider continued on its own.
- Every in-flight tool asks; no rerun allowlist yet.
- Recovery parks after 3 failed attempts, with a Retry button.
- Automatic continuation covers every provider the measurement marks as able.

**Platform notes.** macOS and Windows deliver `suspend` and `resume`. On Linux they need a logind session; without them, classification falls back to the network-online transition plus a wall-clock gap detected by the Phase 0 drift sampler.

**Exit criteria.** For every provider the table marks as able to continue, a turn interrupted by a 10-minute sleep continues automatically within 10 s of wake with no duplicated tool action. For the rest, the thread shows the accurate uncertain or retrying state. A user Stop before sleep is never resumed. Remote SSH turns reattach rather than restart.

### Phase 5: Backend liveness that survives a crash (gated on the Rust background-service plan)

**Goal.** A backend crash does not look like a network outage to the renderer.

1. Today the supervisor is a child of the server and dies with it. Under the Rust background-service plan, the service owns the backend's lifetime and restarts it. The renderer's reconnect target, the local port, is then stable across crashes, and the service can publish `backend restarting` and `backend ready` over the same bridge channel as Phase 2.
2. Consumer cursors stay in the renderer's `localStorage` and in SQLite sequences, so no new persistence is needed. The service's job is only to make the restart fast and announced.

**Exit criteria.** Defined by that plan. This plan records the requirement and stops.

### Recommended execution order

Resilience first, smallest risk first, each step shippable on its own:

1. **Phase 0 and the storm guard from Phase 1b item 6** (web and server, about two days). Gives attributed causes and stops the client from hammering a frozen server. No behavior change for a healthy connection.
2. **Phase 1 and Phase 2** (web and desktop, about three days). Never give up, OS signals, fail-fast requests. This is what the user feels first.
3. **Phase 1b items 1 to 3** (server, about one to two weeks). Worker-thread SQLite starting with migrations and baseline verification, chunked migrations with progress, asynchronous SSH with deadlines. This removes the cause of most real drops. Validate with the Phase 0 lag monitor on the 2.86 GB dev database before moving the remaining queries.
4. **Phase 6: continue turns after sleep and wake** (server, web and desktop, about two to three weeks). Starts with the provider measurement, which needs only Phase 2, then the durable-intent slice, classification, safe continuation and remote reattachment. Runs after step 3 so continuation is not tested against a server that still freezes.
5. **Phase 1b items 4 and 5** (server, a few days). Usage query bound, discovery calmed, Cursor probes lazy.
6. **Phase 4** (Rust and server, about a week). Link health wired, supervisor route in dev.
7. **Phase 3** (web and server, about a week). The resume test matrix, run against the new transport.
8. **Phase 5 and D7** inside the Rust background-service plan, with Phase 0 data as input.

Run one implementer thread per step, with the plan as the contract and a review before the next step starts. Steps 1 and 2 run in parallel on 21 October 2026 under this file-ownership split, because both would otherwise edit the web transport:

- **Thread A, server diagnostics.** Owns `apps/server`, the new contract schemas in `packages/contracts`, and the diagnostics view in `apps/web/src/components/settings`. Delivers Phase 0 items 1, 3, 4 and 5 on the server side, the report RPC contract and handler, and Phase 0 item 6.
- **Thread B, client transport and desktop.** Owns `apps/web/src/rpc`, `apps/web/src/components/WebSocketConnectionSurface*`, `DesktopBackendStartupCoordinator.tsx` and `apps/desktop`. Delivers Phase 1, Phase 2, the storm guard from Phase 1b item 6, page-load tagging from Phase 0 item 2, the renderer side of the report RPC once Thread A's contract exists, and rendering of the `server.stalled` lifecycle event.
- Neither thread edits files owned by the other. A typecheck or test failure in the other thread's files is reported, not fixed. Neither thread commits.

## Risks And Decision Gates

- **D7, Rust-owned socket gateway: deferred, revisit after Phase 1b and the Rust background-service plan.** The option: a Rust process listens on the local port, keeps the renderer's socket open across server freezes and restarts, answers keepalives itself, buffers and replays orchestration batches from its own cursor store, and reconnects upstream to the TypeScript server. What it would buy: the renderer never sees a disconnect when the server restarts or stalls, and keepalive, backpressure and replay live in one native place. What it costs: a second hop for every RPC, Effect RPC stream state that must be re-established upstream on every server restart, a new protocol boundary to version, and the same failure if the server itself is frozen, because no request can complete. What makes it worthwhile: Rust owning the backend's lifetime, so a crash becomes a fast announced restart behind a stable socket. That ownership is exactly what the Rust background-service plan proposes. Decision: fix the causes first (Phase 1b), make the client never give up (Phase 1), wire OS signals (Phase 2), then decide the gateway inside the background-service plan with Phase 0 data in hand. A full rewrite of the server in Rust was rejected: the provider SDKs are TypeScript and the architecture contract keeps canonical state in TypeScript.
- **D6, storage engine: decided 21 October 2026, worker thread.** Resilience is the priority. A worker thread removes the main-thread freeze now without changing storage ownership. A Rust storage engine would not be more resilient by itself and would take longer. Phase 1b uses a worker thread. If you want SQLite access owned by Rust instead, that is a separate plan with a migration path and is not recommended for this problem. Default is the worker thread.
- **D3, unbounded retries: approved 21 October 2026.** Exponential from 1 s to a 30 s cap with full jitter, no give-up. The Restart hatch stays for real faults.
- **D4, supervisor route in dev by default: approved 21 October 2026.** Adds a Rust debug build to `bun dev:desktop`, which the system monitor already triggers. `BIGBUD_DESKTOP_SUPERVISOR_ENABLED=0` remains the opt-out.
- **D5, heartbeat values: approved as starting values 21 October 2026.** 5 s interval, 10 s timeout, 2 consecutive failures with no inbound activity. Phase 0 data decides the final numbers. With Phase 0's stall signal in place, a stalled server is reported as stalled rather than as a network failure, which removes the main false-positive risk.
- **Jitter and two consumers.** The main window and the floating assistant reconnect independently. Jitter prevents them from hitting the server at the same instant after wake.
- **Replay budget increases memory.** A larger direct-route budget holds more events in the server process per consumer. Bound it by bytes as well as count.
- **No regression of existing guarantees.** Delivery golden, acknowledgement, baseline and fallback tests must keep passing unchanged through Phases 1 to 4.

## Testing And Validation

**Server stall tests:** a migration fixture against a 3 GB database copy asserting main-thread blocking under 1 s per step; SSH unlock against a black-holed address asserting the deadline and an unblocked event loop; an event-loop lag assertion wrapped around the usage-summary query.

**Unit and browser tests:** `wsConnectionState`, `wsTransport`, `wsHeartbeat`, `WebSocketConnectionSurface.*.browser.tsx`, `-__root.recovery.*.test.ts`, `-__root.delivery-routing.test.ts`, `desktopSupervisorDelivery*.test.ts`, Rust `connection.rs` and `owner_session.tests.rs`.

**Focused runs:**

```sh
bun run --cwd apps/web vitest run src/rpc src/routes
bun run --cwd apps/web test:browser
bun run --cwd apps/server vitest run src/desktop-supervisor src/ws
cargo test --locked --package bigbud-desktop-supervisor
```

**Sleep and wake scenarios (Phase 6):** for each provider, close the lid for 1, 10 and 30 minutes during a streaming turn and during a running tool, then open it. Record continue, retry, error or hang, the time to resume, and whether any tool action ran twice. Repeat once on an SSH remote project.

**Manual scenarios, each ending with the thread view matching the server:**

```sh
# 1. Server stalls for 30 s, then continues
kill -STOP <server pid>; sleep 30; kill -CONT <server pid>
# 2. Server dies mid-turn
kill -9 <server pid>
# 3. Network flap: toggle Wi-Fi off for 2 minutes, then on
# 4. Sleep: close the lid for 10 minutes mid-turn, then open it
# 5. Long absence: leave the app disconnected for 1 hour, then restore the server
```

**Required repository checks:** `bun fmt`, `bun lint`, `bun typecheck`, `bun run test`, plus the three Rust checks for Phase 4.

**Platform coverage:** macOS and Windows for all phases. Linux for Phases 1, 3 and 4, with the Phase 2 limitations recorded.

## Acceptance Criteria

- No "Retries exhausted" state exists. A disconnected app reconnects on its own once a server is reachable, with attempts visible in the toast.
- Wake from sleep, unlock and network restoration each start a reconnect within 5 s on macOS and Windows.
- A dead socket is detected within 20 s while no events are flowing, and never while events are flowing.
- All five manual scenarios end with the thread view equal to the server's read model, with partial streamed text preserved.
- Each disconnect in diagnostics has a cause and a trigger, and page reloads are excluded.
- The server's main thread shows no stall over 50 ms in steady state on a 3 GB database, and a heavy migration shows progress instead of freezing the app.
- A frozen or slow server produces at most one pending upgrade per renderer, never a storm.
- A turn interrupted by a 10-minute sleep continues automatically within 10 s of wake for every provider the conformance table marks as able, with no duplicated tool action, and shows an accurate uncertain state for the rest.
- Dev runs the supervisor route, and the Rust supervisor reports link health that the server surfaces as lifecycle states.
- All touched files stay at or under 400 lines, and all repository checks pass.

## Open Questions

- Phase 6: after the provider measurement, which providers should continue automatically first? **Decided, 22 October 2026:** every provider the measurement marks as able.
- D7: after Phase 1b and Phase 0 data, is the Rust socket gateway worth building inside the background-service plan?
- Which step of the recommended order starts first, and does the user want steps 1 and 2 in parallel?
