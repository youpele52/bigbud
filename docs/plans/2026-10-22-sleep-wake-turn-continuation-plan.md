# Continue running turns after sleep and wake: implementation plan

**Date:** 22 October, 2026
**Status:** Implemented locally, not committed, 22 October 2026. Second review fixes on 23 October 2026. Phases 1 to 6 are implemented with their tests. Phase 7's automated checks were run by both threads. The manual probe runs are still to do, and they gate keeping automatic continuation on by default. Deviations are in [Implementation notes](#implementation-notes).
**Owner:** bigbud server, desktop, web and Rust maintainers (two implementer threads, see [Execution](#execution))

## Summary

When the laptop sleeps during a running turn, bigbud today shows the turn as failed, stalled or still running forever, depending on the provider. This plan delivers Phase 6 items 3 to 7 of the [connection resilience plan](2026-10-21-connection-resilience-plan.md) under the decisions recorded on 22 October 2026 in the [auto-resume plan](2026-09-10-rust-coordinated-thread-auto-resume-plan.md#raised-by-the-22-october-2026-revalidation).

After this plan, when you open the lid:

- If the provider kept going, the turn carries on, and the thread says the provider continued on its own.
- If the model request was cut and no tool was running, bigbud continues the turn once, automatically, as a linked follow-up. A blue "Resuming after sleep" state shows while it does.
- If a tool may have been running, bigbud does not continue. The thread names the tool, says its outcome is unknown, and offers Continue or Dismiss.
- After 3 failed automatic attempts, the turn parks with a Retry button.
- Remote tool processes run by the Rust remote agent are reattached, never restarted, and their results survive a long sleep.

The invariant is unchanged: **reconcile before continuing; never blindly replay potentially accepted work.**

## Related Work

- Bigbud note / Kanban card: none identified. The work came from the conversation that recorded the 22 October decisions; no note or card was created for it.
- [Connection resilience plan](2026-10-21-connection-resilience-plan.md), Phase 6. This plan implements its items 3 to 7. Item 1 (measurement) is manual and runs separately; item 2 (revalidation) is done.
- [Durable thread recovery and automatic resume](2026-09-10-rust-coordinated-thread-auto-resume-plan.md): the "Phase 6 slice" and the decisions in its Open Questions and research proposals. This plan must not contradict them.
- Research: [Sleep and wake continuation - open-source prior art](../research/Sleep%20and%20wake%20continuation%20-%20open-source%20prior%20art/README.md) (22 October 2026) and [Durable connections - OpenCode, Pi and a Rust layer](../research/Durable%20connections%20-%20OpenCode,%20Pi%20and%20a%20Rust%20layer/README.md) (21 October 2026).
- Measurement kit: [Sleep and wake provider conformance](../research/Sleep%20and%20wake%20provider%20conformance/README.md), `scripts/sleep-wake-probe.ts`.
- Recent commits: `13b90621ba` (never-give-up reconnect, Electron power signals), `3a5d79d4c6` (SQLite worker, async SSH), `733ee212bf` (durable pending-start gate), `819119dc3c` (remote Codex start freeze).

## Problem

Observed facts, from code reading on 22 October 2026 (line numbers at the current `main`):

1. **The server never hears about sleep.** Electron main publishes `suspend`, `resume` and `online` only to renderer windows (`apps/desktop/src/connectivity/connectivitySignals.main.ts:20-24`). No main-to-server channel exists after bootstrap: the fd 3 bootstrap pipe is ended once the envelope is written (`apps/desktop/src/backend/backendManager.ts:256-273`), stdin is ignored (`:185-187`), and fd 4 is server-to-main only (`backendStartupStatusPipe.ts`).
2. **The server's own sleep detector is wrong on macOS and absent on Linux.** `EventLoopLagMonitor` sets `monotonicIncludesSleep` for `win32` only (`apps/server/src/connection-diagnostics/Layers/EventLoopLagMonitor.ts:55`). On macOS, Node's `performance.now()` counts sleep (libuv uses `mach_continuous_time`), so a lid close is logged as a server stall. On Linux, `performance.now()` stops during sleep and the classifier has no branch for "wall clock ran ahead of monotonic" (`EventLoopLagMonitor.logic.ts:60-83`). Nothing outside diagnostics consumes the result.
3. **Electron's `suspend` is unreliable on every OS.** On macOS Chromium lets the OS sleep before JavaScript sees `suspend`; on macOS and Windows a missed `suspend` also suppresses `resume`; on Linux the logind delay lock is released when the handler returns. Electron main already synthesizes a `resume` from a 30 s tick gap (`connectivitySignals.ts:106-117`). Source: research `sleep-detection.md`.
4. **No durable record says a turn may have reached the provider.** The external call is `routed.adapter.sendTurn(input)` in `apps/server/src/provider/Layers/ProviderService.ts:188`. The only marker before it is in memory (`ProviderCommandReactorSessionOps.send.ts:190`). `recordAcceptedSendTurn` writes liveness after the call, without a transaction, and swallows errors (`ProviderService.sendTurn.record.ts:18-95`, `ProviderService.turnLiveness.ts:120-126`).
5. **A cut turn surfaces in different ways per provider.** `runtime.error` sets the session to `error` and keeps `activeTurnId` (`ProviderRuntimeIngestion.processor.runtime.ts:314-336`). Claude ends the turn as failed and stops the session (`Claude/Adapter.stream.ts:152-186`). Codex app-server exit becomes `session.exited` → `stopped`. Pi and Copilot surface `runtime.error`. Nothing distinguishes a sleep cut from a real provider failure.
6. **bigbud cannot tell which tool was in flight.** Tool activities drop the runtime event's `itemId` (`ProviderRuntimeIngestion.helpers.activities.tooling.ts:13-80`; `OrchestrationThreadActivity` has no item ID). A `tool.started` cannot be paired with its `tool.completed`.
7. **The turn supervisor can only observe.** `superviseProviderTurns` (`orchestration/Layers/ProviderTurnSupervisor.ts:86-209`) runs every 5 s inside `ProviderRuntimeIngestion.ts:344-349`, loads the whole read model each pass, and only OpenCode V2 implements `inspectActiveTurn` (`best-effort`). Every other adapter returns `unavailable`.
8. **A post-wake backend restart silently drops the turn.** `backendResumeProbe.ts:62-79` restarts a backend that refuses connections after resume. On restart, an orphaned pending start is settled to `stopped` without a resend (`OrchestrationEngine.ts:136-152`) and reconciliation maps a missing session to `stopped`.
9. **The Rust remote agent can lose a finished result during an ordinary sleep.** Results are retained 600 s (`crates/bigbud-remote-agent/src/session/core.rs:63-70`). An operation running longer than 600 s falls out of `record_mut`/`prune` because only `complete` refreshes `expires_at` (`operations/registry.rs:48,155,348-357`). An attach whose cursor fell behind the 8 MiB output window fails with `ProcessReplay` before the snapshot and exit code are sent (`session/process_handlers.rs:292-306`). The TypeScript client makes 3 immediate reconnect attempts and gives up (`remoteAgentProcessClient.ts:342-377`).

## Goals

1. A turn cut by sleep is classified `interrupted-by-sleep`, on macOS, Windows and Linux, with or without a renderer window.
2. When the model request was cut and no tool was in flight, the turn continues automatically once within 10 s of the network being back, as a linked continuation, without resending the original prompt.
3. When a tool may have been in flight, nothing is sent. The thread names the tool and offers Continue and Dismiss.
4. A provider that continues on its own is observed, not continued again, and the thread says so.
5. A user Stop before or during sleep is never resumed.
6. A backend restart after wake shows the uncertain prompt instead of silently stopping the turn.
7. Remote tool processes survive a 30-minute sleep with their result intact and are reattached, never respawned.
8. Rust carries the bounded native pieces: the suspended-time clock and the remote agent's retention and attach behavior.

## Non-Goals

- Automatic resume after crash, quit or reboot. App quit suspends intent; nothing resumes it in this plan. That is the full auto-resume plan.
- Durable-before-ACK remote output receipts (auto-resume Phase 4). A backend restart after wake is treated as uncertain instead.
- Reattaching remote Codex. Remote Codex runs as a plain `ssh … codex app-server` child (`codex/codexAppServerManager.process.remote.ts:28-50`), not under the remote agent. A dropped link ends that session, and the turn takes the ordinary classification and policy path.
- Keeping Pi alive across a backend restart, provisional partial-output flushing, and a rerun allowlist for safe tools (all decided "not now").
- Absorbing dead-thread turn-start recovery (`withTurnStartRecovery`) into the coordinator.
- Changing the delivery supervisor protocol beyond one additive heartbeat field.
- Setting `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`. It must stay unset.

## Current State

See [Problem](#problem) for the facts this plan changes. What must not change:

- The durable pending-start gate (`orchestration/PendingTurnStart.logic.ts`, migration 136) and its exits. A continuation is an ordinary `thread.turn.start` and passes through the same gate and queue.
- The delivery golden, ACK, baseline and fallback tests, and the remote agent's refusal to re-run an operation after an agent restart (`AGENT_RESTARTED` expiry, `registry.rs:284-300`).
- `ProviderTurnSupervisor`'s current health projections (checking, stalled, lost session) and their tests.
- OpenCode V2's `provider_turn_admissions` (migration 123) stays OpenCode V2's own admission journal. The new generic dispatch-attempt table reuses its idea, one state machine per attempt with a revision, but not its OpenCode-specific columns.

Migration numbering: the highest migration is 136. Use 137 and up, registered by import plus a `migrationEntries` row in `apps/server/src/persistence/Migrations.ts`.

Files near the 400-line limit that this plan touches and must split rather than grow: `ProviderService.ts` (396), `ProviderCommandReactorHandlers.ts` (396), `ProviderCommandReactorHandlers.session.ts` (393), `ProviderRuntimeIngestion.processor.runtime.ts` (397), `OrchestrationEngine.commandProcessing.ts` (389), `ProviderRuntimeIngestion.ts` (382), `apps/desktop/src/main.ts` (392), `crates/bigbud-remote-agent/src/session/core.rs` (397), `operations/journal.rs` (386), `remoteAgentProcessClient.ts` (377), `ChatViewChatBody.tsx` (369).

## Design

### Sleep epochs: one server-side view of "the machine slept"

A new server service, `SystemSleepEpochs` (`apps/server/src/system-sleep/Services/SystemSleepEpochs.ts`, `Layers/SystemSleepEpochs.ts`), merges three evidence sources into epochs `{epochId, startedAt (estimated), endedAt, durationMs, sources[]}`:

1. **Desktop hints.** Electron main writes JSON lines `{kind: "suspend" | "resume" | "online" | "offline", sequence, occurredAt, online}` to a new main-to-server pipe on fd 5, opened at spawn and kept for the backend's lifetime. Only Electron main holds that fd, so the renderer cannot forge a hint. `resume` is the anchor; `suspend` is a hint only. On Linux the suspend line is written synchronously (`fs.writeSync`) inside the handler.
2. **Server gap detector.** `EventLoopLagMonitor` classifies sleep on every OS: on `darwin` and `win32` the existing rule (gap ≥ 30 s, wall and monotonic agree within 2 s, CPU under 5 %); on `linux`, compare `os.uptime()` (boottime, counts suspend) with `performance.now()` (stops during suspend), so a wall-clock step cannot fake a sleep. Each detection is published to `SystemSleepEpochs`, and the existing diagnostics record stays.
3. **Rust suspended-time clock.** `bigbud-desktop-supervisor` adds `suspended_millis` to its `Heartbeat` frame (additive proto field, protocol minor 1.3 → 1.4): total time suspended since boot, from `CLOCK_BOOTTIME − CLOCK_MONOTONIC` on Linux, `mach_continuous_time − mach_absolute_time` on macOS, and `QueryInterruptTime − QueryUnbiasedInterruptTime` on Windows. The server opens an epoch when the value jumps by 15 s or more between heartbeats. This is exact and immune to wall-clock changes. It exists only where the supervisor route runs (packaged builds, or `BIGBUD_DESKTOP_SUPERVISOR_ENABLED=1`), so it is evidence, not a dependency.

Epochs from different sources within 60 s of each other merge. The service keeps the last 32 epochs in memory and exposes `latest`, `isWithinSleepWindow(at)`, and a stream of `epoch-ended` and `network-online` events. The window around an epoch is `[startedAt − 5 s, endedAt + 60 s]`, because on macOS and Windows every pending timer, including provider and heartbeat timeouts, fires right at wake.

### Durable intent and dispatch attempts (migration 137)

Two tables, in one migration `137_ThreadRecoveryIntents.ts`:

- `thread_recovery_intents`: key `(thread_id, message_id)`. Columns: `provider` (nullable until dispatch), `turn_id` (nullable until bound), `disposition` (`active`, `suspended-for-exit`, `revoked`, `settled`), `recovery_status` (`none`, `interrupted-by-sleep`, `observing`, `continuing`, `awaiting-user`, `parked`, `provider-continued`, `continued`), `recovery_detail_json` (tool summary, reason, sleep epoch), `attempt_count` (bigbud's own continuation attempts only), `last_attempt_at`, `continuation_message_id`, `revision`, `created_at`, `updated_at`. Index on `(disposition, recovery_status, updated_at)`.
- `provider_dispatch_attempts`: key `attempt_id`. Columns: `thread_id`, `message_id`, `intent_revision`, `payload_digest`, `state` (`prepared`, `may-have-been-sent`, `provider-acknowledged`), timestamps. At most one non-acknowledged attempt per intent (a partial unique index, checked in the repository).

Writes:

- The intent is inserted in the command transaction, right after `thread.turn-start-requested` is appended (`OrchestrationEngine.commandProcessing.ts:155-216`). Put the hook in a new focused module; do not grow `commandProcessing.ts`.
- `prepared`, then `may-have-been-sent`, are written in `ProviderService.sendTurn` after `resolveRoutableSession` and before `routed.adapter.sendTurn`. If the write fails, the send does not happen and the turn fails as a turn-start failure. Move `sendTurn` into `ProviderService.sendTurn.ts` to make room.
- `provider-acknowledged` and the liveness writes from `recordAcceptedSendTurn` share one `sql.withTransaction`.
- A user Stop (`thread.turn-interrupt-requested`, session stop) sets `disposition = revoked` in the same command transaction. `stopAll` gets a `reason` (`app-exit` by default) and sets every active intent to `suspended-for-exit`, never `revoked`.
- A turn that completes normally sets `settled`.

Turns accepted before migration 137 have no intent and are never continued automatically (decision 5).

### Tool-in-flight evidence

Persist the runtime event's `itemId` in tool activity payloads (`payload.itemId`, optional, contracts change) for `tool.started`, `tool.updated` and `tool.completed`. A tool is **in flight** for a turn when a `tool.started` has no `tool.completed` with the same `itemId`. When an activity has no `itemId`, an unmatched `tool.started` counts as in flight. That is the conservative choice: ask rather than continue. Remote-agent tool owners in `may-have-been-sent` or `outcome-unknown` for the thread also count as in flight.

### The recovery coordinator (ProviderTurnSupervisor, grown)

`ProviderTurnSupervisor` becomes its own Effect service (`orchestration/Services/ProviderTurnSupervisor.ts`, `Layers/ProviderTurnSupervisor.ts`), started by the orchestration reactor composition. `ProviderRuntimeIngestion` stops running it. It keeps every current health behavior, and adds:

- **Inputs:** the existing 5 s tick; `SystemSleepEpochs` `epoch-ended` and `network-online` events; session-error and turn-failure observations from ingestion (a small published stream, not direct calls).
- **Per-pass work** is bounded and indexed. Query unresolved intents and active liveness rows. Load only the threads involved, not the whole read model per pass.
- **Modules:** `ProviderTurnSupervisor.health.ts` (today's behavior), `.classify.logic.ts`, `.policy.logic.ts`, `.continue.ts`, `.resolve.ts`, each under 400 lines, pure logic separated from effects.

Classification: an intent with `disposition = active` is `interrupted-by-sleep` when its turn fails, errors, exits or times out inside a sleep window. That covers a session `error`, a failed `turn.completed`, `session.exited`, or a `runtime.error`. A provider's own sleep label also counts, for example Claude Code's "Connection lost while your computer was asleep". A failure outside any window keeps today's behavior.

Policy, for each `interrupted-by-sleep` or post-wake intent:

1. **Still running:** `inspectActiveTurn` says running, or meaningful progress arrived after wake without a bigbud continuation. Set `provider-continued` and show the notice. Do nothing else.
2. **Finished:** inspection says completed, or a completed `turn.completed` arrived. Settle.
3. **Cut, no tool in flight:** if the network is down, wait for `network-online` (not an attempt). Otherwise send one continuation (below) and set `continuing`, then `continued` when it binds.
4. **Cut, tool in flight:** set `awaiting-user` with the tool's summary. Send nothing.
5. **No progress after wake, no terminal event, inspection unavailable:** after 120 s of awake time, set `awaiting-user` with reason `no-activity-after-wake` and the in-flight tool, if any. Actions: Keep waiting, or Stop and continue.
6. **User activity wins:** if the user sends a message, queues a prompt or presses Stop on the thread after the cut, settle the intent and do not continue.
7. **Parking:** each continuation send counts one attempt. Waiting for the network, provider-native retries and sleep time do not count. When a continuation fails and `attempt_count` reaches 3, set `parked`.
8. **Post-wake backend restart:** the desktop passes `startReason: "resume-probe-restart"` in the fd 3 bootstrap envelope when `restartUnresponsiveBackend` caused the start. On such a start, every intent whose latest attempt is `may-have-been-sent` or `provider-acknowledged` and is not settled becomes `awaiting-user` with reason `backend-restarted-after-wake`, instead of the silent `stopped` settlement. Both the orphaned pending-start path (`OrchestrationEngine.ts:136-152`) and reconciliation (`ProviderRuntimeIngestion.reconcile.ts`) must honor it. Ordinary restarts keep today's behavior.

**Continuation:** a server-originated `thread.turn.start` through the normal command path. Its `originSegments` are `[{kind: "sleepRecovery", actor: "automation", verified: true}]`, which adds a new `MessageOriginKind`, and it links the original message ID in the recovery detail. Text: "Your previous response was interrupted when the computer went to sleep. Continue the task from where it stopped. Do not repeat actions that already completed, and check the current state before relying on anything that may not have finished." It never resends the original prompt. `ThreadWatch.logic.ts:98-153` (`dispatchThreadWatchTriggerTurn`) is the template.

**Kill switch:** `BIGBUD_SLEEP_CONTINUATION=0` disables automatic continuation. Classification and the prompts still show.

### What the user sees (web)

The thread projection gains a `recovery` field `{status, reason, toolSummary, attempt, provider, updatedAt}`, persisted in `projection_threads.recovery_json` (migration 138) by a projector on a new `thread.recovery-updated` event. A new command, `thread.recovery.resolve` `{action: "continue" | "dismiss" | "retry" | "keep-waiting" | "stop-and-continue"}`, lets the user act. Continue and Retry send the same continuation, user-authorized, and do not count toward parking.

Rendered in `ThreadRecoveryNotices` next to `ThreadRecoveryNotice` (`apps/web/src/components/chat/...`), using `ChatBanner`, `useThreadNoticeDismissal` and the toast colour rules:

- **Blue, info:** "Resuming after sleep…" while `continuing`. Hidden for the first 3 s, so a quick success never flashes.
- **Blue, info, transient (6 s):** "<Provider> continued on its own after sleep." on `provider-continued`.
- **Amber, warning:** "The computer slept while <tool> was running. Its outcome is unknown. Check before continuing." Actions: Continue, Dismiss. The wording is "unknown", never "failed" or "cancelled".
- **Amber, warning:** "No activity since wake." Actions: Keep waiting, Stop and continue.
- **Amber, warning:** "bigbud restarted after wake. This turn's outcome is unknown." Actions: Continue, Dismiss.
- **Red, error:** "Couldn't resume after 3 tries." Action: Retry.

The sidebar keeps its existing pills. `continuing` shows blue "Working".

### Remote agent (Rust) and its client

- **Retention:** keep a terminal result (state, exit code, output watermark) for 24 h or until acknowledged. Retained output stays bounded by the existing 8 MiB per operation and the 64 MiB journal cap. Accepted-operation retention moves to 24 h as well. Running operations never expire: `record_mut`/`prune` must skip non-terminal records, or `accept` and `start` refresh `expires_at` while running.
- **Attach after a replay gap:** `handle_process_attach` returns the snapshot and `ProcessCompleted` with a `replay_gap = true` marker when the cursor fell behind the retained window, as the PTY path already does, instead of failing with `ProcessReplay`. The TypeScript client surfaces "finished with exit N, output partly lost" rather than "outcome unknown".
- **No idle exit while an operation is open:** confirm, and add a test, that the agent does not exit on idle while any operation is non-terminal.
- **Delayed reattach:** `remoteAgentProcessClient.ts` keeps its 3 immediate attempts, then waits for `network-online` or the next sleep `epoch-ended`, and keeps retrying with backoff (1 s to 30 s, jittered) until the operation's retention would have expired. Only then does it mark the owner `outcome-unknown`. Reattach never spawns.
- Bump the remote-agent protocol minor version for the `replay_gap` field. Old agents simply never set it.

## Phases

Each phase lists its owner thread. Thread S is server and contracts. Thread N is native, desktop and web. See [Execution](#execution).

### Phase 1: Contracts (Thread S, first, small)

All in `packages/contracts`, by subpath, schema only:

1. Desktop sleep hint line schema (`server/ipc.desktop.ts` or a new `server/desktopLifecycleHint.ts`) and the bootstrap envelope's optional `startReason`.
2. `MessageOriginKind` gains `sleepRecovery`.
3. Thread `recovery` field, the `thread.recovery-updated` event and the `thread.recovery.resolve` command.
4. Optional `itemId` on tool activity payloads.

Exit: `bun typecheck` passes, with contract tests for backward-compatible decoding (old payloads without the new fields decode).

### Phase 2: Sleep evidence (Thread S server side, Thread N desktop and Rust)

- Thread N: fd 5 hint pipe in `backendManager.ts`, written from `connectivitySignals.main.ts`, with a synchronous write on Linux; `startReason` in the fd 3 envelope from `restartUnresponsiveBackend`; Rust `suspended_millis` in the supervisor heartbeat, with per-OS unit tests for the reader and the proto bump.
- Thread S: `SystemSleepEpochs` service; the fd 5 reader (`cli.config.ts` area, new module); the `EventLoopLagMonitor` fix for darwin and Linux; the supervisor heartbeat consumer in `apps/server/src/desktop-supervisor`.
- Also fix the wrong macOS clock comments in `EventLoopLagMonitor.logic.ts`, `scripts/lib/sleep-wake-probe.clock.ts` and the conformance README. The probe's detection is unaffected, because it uses wall-clock gaps and measures drift.

Exit: unit tests for each source and for epoch merging, including a missed suspend, a doubled resume, Linux without hints, a wall-clock step without sleep (no epoch), and macOS gap classification.

### Phase 3: Durable intent and dispatch attempts (Thread S)

Migration 137, repositories (`persistence/Services|Layers/ThreadRecoveryIntents.ts`, `ProviderDispatchAttempts.ts`), the writes listed in [Design](#durable-intent-and-dispatch-attempts-migration-137), Stop revocation, the `stopAll` reason, and `itemId` persistence in ingestion.

Exit: tests proving `may-have-been-sent` is durable before `adapter.sendTurn` (a failing write prevents the send), at most one open attempt per intent, Stop revokes, `stopAll` suspends, and acknowledged plus liveness writes are atomic. Existing pending-start, reactor and ingestion suites pass unchanged.

### Phase 4: Coordinator, classification and continuation (Thread S)

Grow `ProviderTurnSupervisor` as designed. Add migration 138 and the projector for `recovery_json`, `thread.recovery.resolve` handling, the post-wake restart handling, and the kill switch.

Exit: deterministic-clock tests for every policy branch. They must cover sleep during streaming (continues once); sleep during a tool (prompt, nothing sent); provider continued (notice, no send); the network still down at wake (waits, no attempt counted); three failures (parked); Stop before sleep (never resumed); a user message after the cut (no continuation); a post-wake restart (prompt, not `stopped`); an ordinary restart (unchanged); and an OpenCode V2 turn running per inspection (observed). All existing supervisor health tests pass.

### Phase 5: Remote agent (Thread N, Rust and client)

Retention, running-operation expiry, attach after a replay gap, the idle-exit guard, the protocol minor bump, and delayed reattach in the client.

Exit: Rust tests for retention across a simulated 30-minute gap, a running operation older than 600 s staying attachable, attach after an output overflow returning the exit code with `replay_gap`, and no idle exit with an open operation. `cargo fmt`, `clippy -D warnings` and `cargo test` pass. Client tests cover reattach waiting for `network-online`, and `outcome-unknown` only after retention.

### Phase 6: UI (Thread N, after Phase 1 contracts land)

Banners and actions as designed, logic in `.logic.ts` files with unit tests, and browser tests for each state and action, including keyboard access and dismissal persistence.

Exit: web unit and browser tests pass, and the banners follow the colour rules.

### Phase 7: Validation and docs (both threads, then manual)

- Run `bun fmt`, `bun lint`, `bun typecheck`, `bun run test`, and the Rust commands.
- Update this plan's status, the connection resilience plan's Phase 6 status, and the auto-resume plan's Phase 6 slice notes.
- Manual: run the conformance probe's first runs after the build (Claude streaming 1 min, Claude tool 1 min, Codex streaming 10 min) and check the outcome column against the expected policy.

## Execution

Two implementer threads in the current checkout (no worktrees), with disjoint file ownership. Neither commits. A failure in the other thread's files is reported, not fixed.

- **Thread S (server and contracts):** owns `packages/contracts`, `apps/server/src` except `apps/server/src/remote-agent/remoteAgentProcessClient.ts`, and `scripts/lib/sleep-wake-probe.clock.ts`. Phases 1, 2 (server side), 3 and 4. Phase 1 goes first, so Thread N can build against it.
- **Thread N (native, desktop, web):** owns `crates/`, `protocol/`, `apps/desktop/src`, `apps/web/src`, `apps/server/src/remote-agent/remoteAgentProcessClient.ts` and its tests. Phases 2 (desktop and Rust), 5 and 6. It starts with Rust work, which needs no contracts, then desktop, then UI after Phase 1 lands.
- **Shared seam:** the fd 5 hint line schema and the `startReason` field are defined in Phase 1 by Thread S. The supervisor heartbeat field is defined in `protocol/` by Thread N, and the server consumer in `apps/server/src/desktop-supervisor` (Thread S) is written against that proto field name, `suspended_millis`.

## Risks And Decision Gates

- **False sleep classification.** A real provider outage that happens to fall inside a sleep window gets one automatic continuation. That is bounded by the single attempt and the park limit, and re-asking the model has no side effects.
- **A missed tool.** A provider whose tool events lack `itemId` and arrive out of order could hide an in-flight tool. The rule treats any unmatched `tool.started` as in flight, so the error is towards asking.
- **Double continuation.** A provider that retries internally and also emits an error could get a bigbud continuation while it is still running. Mitigation: before sending, re-check meaningful progress since wake and inspection. Sending also requires the pending-start gate to be clear and no active turn bound.
- **Migration on large databases.** Migrations 137 and 138 create a table and add a nullable column with no backfill. They are cheap.
- **Rollback.** `BIGBUD_SLEEP_CONTINUATION=0` turns off automatic sends. The tables are additive. Older binaries ignore the new columns and tables.
- **Gate for keeping it on by default:** the feature ships on, per decision 12, once Phases 3 and 4 tests are green. If the three probe first runs disagree with the policy, flip the kill switch's default to off until the disagreement is fixed.

## Testing And Validation

Named in each phase's exit. Commands:

```sh
bun fmt && bun lint && bun typecheck
bun run --cwd apps/server vitest run src/system-sleep src/orchestration src/provider src/persistence src/connection-diagnostics src/remote-agent
bun run --cwd apps/web vitest run src/components/chat
bun run --cwd apps/web test:browser
bun run --cwd apps/desktop vitest run src/backend src/connectivity
bun run test
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
```

Manual: the conformance probe runs in [Sleep and wake provider conformance](../research/Sleep%20and%20wake%20provider%20conformance/README.md).

## Acceptance Criteria

- A sleep is detected on macOS, Windows and Linux from at least one source, with a test per source.
- A streaming turn cut by a 10-minute sleep continues once within 10 s of the network returning, with a `sleepRecovery` continuation and no resent prompt.
- A turn with a tool in flight shows the amber prompt naming the tool, and nothing is sent until the user chooses.
- A provider that continues on its own shows the notice and gets no continuation.
- A Stop before sleep is never resumed. A user message after the cut cancels recovery.
- Three failed continuations park the turn with Retry.
- A backend restart after wake shows the uncertain prompt. An ordinary restart is unchanged.
- Remote tool results survive a simulated 30-minute gap, and an overflowed attach still returns the exit code.
- All repository and Rust checks pass. Every touched or new file is 400 lines or fewer.

## Open Questions

None blocking. Recorded defaults, which can be changed later:

- 120 s of awake time with no progress before "No activity since wake".
- 24 h retention for terminal remote results.
- Continuation text as written above.

## Implementation notes

Recorded on 22 October 2026 by the two implementer threads. Everything below is local and uncommitted. Each item is a deviation from the text above, or a choice the plan left open, with the reason. None of them changes the invariant: reconcile before continuing; never blindly replay potentially accepted work.

### Thread S (server and contracts)

1. **Contracts by subpath only.** The new modules (`server/desktopLifecycleHint.ts`, `orchestration/orchestration.recovery.ts`, `orchestration/orchestration.toolActivity.ts`) are not added to the legacy barrel. The fd number is exported as `DESKTOP_LIFECYCLE_HINT_FD = 5`.
2. **`thread.recovery.resolve` is fenced by message.** The command carries an optional `messageId`. The decider ignores a resolve whose `messageId` does not match the thread's current recovery, or whose status is not one a user can act on. A double click or a stale banner is a no-op, never a second continuation. The projected `ThreadRecovery` therefore also carries `messageId`, and `thread.recovery-updated` carries `messageId` and `resolvedAction`.
3. **Internal `thread.recovery.set` command.** The coordinator publishes the projection through the normal command path (an internal command), so the in-memory and SQL projections stay in the same transaction as every other event.
4. **`recovery_json` has its own writer.** `ProjectionThreads.setRecovery` updates only that column (migration 138 adds it if absent). The frequent full thread upsert does not carry it, so it cannot overwrite a newer recovery, and `ProjectionThreads.ts` stays within 400 lines.
5. **Startup operational window.** The startup operational query also loads threads with `recovery_json` set or with an active intent whose `recovery_status` is not `none`, so the coordinator and the UI see them after a restart.
6. **One open attempt, reused.** `markMayHaveBeenSent` reuses the intent's open (not acknowledged) attempt instead of creating a second one. A send with no active intent (turns accepted before migration 137, or sends that are not turn starts) records nothing and proceeds unchanged (decision 5). A failing write blocks the send, as designed.
7. **Acknowledge with fallback.** `provider-acknowledged` and the liveness and binding writes share one transaction. If that transaction fails, it rolls back, and turn liveness (best effort) and then the binding are written without it, exactly as before this feature, so a recovery-table failure never fails an accepted turn or loses its liveness. The attempt then stays `may-have-been-sent`, which is the conservative state.
8. **Revocation sources.** Stop (`thread.turn-interrupt-requested`) and session stop revoke. So do interrupt-and-continue and Send now, which go through the interrupt event, and thread deletion. A new user turn start settles the thread's older intents in the same transaction, except the intent a continuation targets. A queued prompt (`thread.prompt-queued`, not `prompt.alreadySent`) settles intents that are recovering.
9. **Observation inputs.** The coordinator subscribes to the provider runtime event stream and the orchestration domain event stream directly, instead of a new stream published by ingestion. The evidence is the same, and ingestion does not grow (it is 366 lines). A failure that arrives before its sleep evidence (for example, timers fire before the desktop resume hint is read) is kept for 30 s of awake time and classified again when an epoch appears.
10. **Turns running across a sleep.** On `epoch-ended`, active intents whose turn is still running and whose attempt may have been sent move to an internal `observing` status. It is not projected and shows no banner. Policy items 1, 2 and 5 then apply.
11. **Post-wake backend restart.** It is handled once, at coordinator start (`ProviderTurnSupervisor.startup.ts`), over intent rows. The orphaned pending-start settlement in `OrchestrationEngine.ts` and the reconciliation in `ProviderRuntimeIngestion.reconcile.ts` still settle the session and the pending-start gate, so the queue is never wedged. The intent itself becomes `awaiting-user` with reason `backend-restarted-after-wake`, and the thread shows the prompt instead of only a silent `stopped`. Intents suspended by the old process's graceful `stopAll` within the last 120 s count as that process's. On an ordinary start, intents a crashed process left `active` become `suspended-for-exit`, the same as an app exit, and are never resumed. Prompts already waiting (`awaiting-user`, `parked`) are kept.
12. **Kill switch shows a prompt.** With `BIGBUD_SLEEP_CONTINUATION=0`, a cut turn with no tool in flight becomes `awaiting-user` with reason `interrupted-by-sleep` (Continue, Dismiss). Otherwise the user would see nothing. The web needs that combination as well as the reasons in the design.
13. **Success clears the banner.** When a continuation binds, the intent is settled with `recovery_status = continued`, and the thread projection is cleared to `null` so the blue banner disappears (UI item "on success it disappears").
14. **Stop and continue.** Implemented as `providerService.interruptTurn`, falling back to `stopSession`, then one user-authorized continuation once the thread is idle. It does not dispatch `thread.turn.interrupt`, because that event revokes the intent by design.
15. **Remote-agent tool owners.** Only `shell:<threadId>` owners are thread-scoped. `tool:<invocationId>` owners carry no thread ID, so they cannot be attributed and are not counted. A `shell:` owner in `may-have-been-sent` or `outcome-unknown` counts as a tool in flight, named "Remote shell command".
16. **Unknown network is online.** Without desktop hints (Linux without logind, or no desktop), the network state is unknown and treated as online. The gap detector and the supervisor clock still open epochs.
17. **Desktop supervisor protocol.** The server decodes `Heartbeat.suspended_millis` (field 2) when present and keeps `DESKTOP_SUPERVISOR_PROTOCOL_MINOR = 3` as its minimum. The supervisor now speaks 1.4, but requiring 1.4 would reject an older supervisor for a field that is only evidence. A value of `0` or a missing field is ignored, and a decrease resets the baseline.
18. **fd 5 detection.** The server reads fd 5 only in desktop mode with a bootstrap envelope, and only when the fd is a pipe or socket. Otherwise it logs once and relies on the other sources.
19. **Remote-agent protocol 1.3 compatibility.** `REMOTE_AGENT_PROTOCOL_MINOR` is 3 for `replay_gap`, and the release manifest script writes `protocolMinor: 3`. An agent that is already installed at 1.2 keeps working. Both sides check only the major in the hello, `replay_gap` is additive, and the client infers a gap from `firstRetainedSequence`. The health check compares the installed identity (version, minor, digest) with the bundled artifact, so a 1.2 agent is reported `upgrade-required` and goes through the existing upgrade path, as every release does. Owners pinned to the old runtime keep talking to it until they finish. No compatibility change was needed. Test fixtures that model the 0.2.207 build or fake agents keep `protocolMinor: 2`, which also keeps a 1.2 agent covered against the 1.3 client. Only the local binary check, which must match exactly, uses 3. The server does not decode `replay_gap` in the codec. The client's inference is enough, and the tool runner now reports a replay gap as "finished with exit N, output partly lost" instead of an output-limit overflow.
20. **Reattach wake bridge.** `system-sleep/remoteAgentReattachWakeBridge.ts` calls `notifyRemoteAgentReattachWake()` on every `network-online` and `epoch-ended` event, so a delayed reattach retries at wake instead of at the next backoff tick.
21. **Conformance README.** Its "cannot observe" items 3 and 4 were corrected after implementation: server-side sleep is now detected on all three platforms, and tool activities carry `itemId`. The probe reads neither yet.

### Thread N (native, desktop and web)

1. When its registry is full, the remote agent evicts the oldest finished result, never running work.
2. Finished-output memory is capped at 64 MiB. The oldest results lose their output but keep their exit code, and attaching to them reports a replay gap.
3. Journal compaction drops the output of the oldest completed operations instead of refusing new work.
4. The accepted-operation table evicts its oldest entry instead of refusing.
5. PTY retention stays at 600 s (terminals, 64 slots).
6. A duplicate `ProcessRequest` that hits a replay gap still errors. Only attach changed.
7. The desktop uses a local constant for fd 5. It cannot import the contracts value, because the contracts subpath needs a `.ts` extension that the desktop build does not resolve.
8. On Linux, the synchronous suspend write uses the pipe's internal fd, with a normal write as the fallback.
9. Lazily loaded sidebar thread summaries do not carry `recovery`. The banner reads it from the full thread.

### Review fixes

Recorded on 22 October 2026, after an independent review of the uncommitted implementation. Each fix has a regression test. None of them changes the invariant.

1. **Tools hidden by the work-log throttle.** The runtime activity governor drops non-terminal work-log rows past 40 per category, so a later `tool.started` never reached the read model, and a sleep during a long turn's 21st tool could continue automatically. The coordinator now tracks each thread's current turn and its open tool items by `itemId` from the provider runtime stream, which is lossless and never throttled (`ProviderTurnSupervisor.tools.logic.ts`). That tracking is merged with the activity rows. A suppressed `tool` row counts as an unrecorded tool in flight, unless the tracking saw the whole turn from its `turn.started`. A tool activity without a turn ID counts for the intent's turn when it was created after the turn was requested. The throttle itself is unchanged.
2. **Stale intents resurrected.** An intent is now settled when its failure is classified ordinary, once 30 s of awake time pass with no sleep to explain it (a runtime or session error that left the turn running is kept until the turn ends), when its turn ends `interrupted` or `cancelled` before any recovery started, and on `thread.turn-start-failed` for its message. A failure is classified only when the intent's turn was actually running: the observation names the turn, or the session is running it, or the coordinator's tracking or an active liveness row says it still runs. An unbound intent counts only while its own turn start is pending. The post-wake restart path shared the root cause and is fixed by the settling.
3. **Continuation behind the user's message, or after Stop.** The decider refuses, and never queues, a `thread.turn.start` with a `sleepRecovery` origin while the thread is busy. The command transaction refuses a direct one unless the original intent is still `active` and `continuing` with that message as its continuation (`OrchestrationEngine.recoveryIntents.ts`). Queue flushes are not fenced, so a refusal can never wedge the queue. On a refusal, the coordinator settles the continuation's seeded intent. When the user's activity already settled the original intent, it clears "Resuming after sleep" instead of counting a failed attempt.
4. **Banner text for the other prompt reasons.** `awaiting-user` with reason `interrupted-by-sleep` now reads "The response was interrupted when the computer went to sleep." (amber, Continue and Dismiss). With reason `continuation-failed` it reads "Couldn't resume after sleep." (red, Continue and Dismiss). The tool text shows only for `tool-in-flight`.
5. **Provider sleep label.** The generic `while … suspended` pattern is gone. Only phrases about the machine sleeping count, such as "computer was asleep" or "system went to sleep". "Account is suspended" and "sleeping between retries" no longer look like a sleep.
6. **Stuck "Resuming after sleep" after quitting.** At every start, after the intent handling, the coordinator clears any thread notice whose intent is no longer active. A prompt that still waits for the user (`awaiting-user`, `parked`) on a suspended intent is kept, because the user can still act on it.
7. **Liveness lost when the acknowledgement fails.** Fixed as described in Thread S note 7, which was corrected.
8. **Stuck notice after a user's action.** When the intent behind a resolved prompt was settled, revoked or pruned, or the compare-and-set lost, `resolveRecovery` now resyncs the notice: an active intent republishes its state, and anything else clears the decider's projected `continuing`.
9. **Waiting for the network is bounded.** A cut turn that waits for the network, or for the thread to go idle, asks the user with reason `interrupted-by-sleep` after the same 120 s of awake time. A missed "online" hint can no longer leave the turn waiting silently.
10. **Failures just before suspend.** A held failure now counts awake time only, at most 10 s per check, so a failure observed just before the machine slept still meets the epoch that arrives after wake. Before this fix, the 30 s wall-clock hold expired during the sleep.

Remaining risk: if the network hint stays "offline" after wake and the user chooses Continue, the user-authorized continuation still waits for the network. It asks again after 120 s of awake time, but it does not send until an "online" hint arrives or the network state becomes unknown.

### Second review fixes

Recorded on 23 October 2026, after a second independent review. Numbers follow that review. Each fix has a regression test that fails without it. None of them changes the invariant: reconcile before continuing; never blindly replay potentially accepted work.

1. **`provider-continued` could stick forever.** Progress and completion are now dated by the runtime event's own `createdAt`, not by when the coordinator read it, so events buffered at wake that waited behind the coordinator no longer look like progress after wake. In `provider-continued`, an idle thread (no active turn, no pending start, nothing awaiting approval) with no completion for 120 s, counted from wake or the latest progress, moves to `awaiting-user` with reason `interrupted-by-sleep` (Continue, Dismiss). Nothing is sent from that state. Tests: "progress buffered at wake is not the provider continuing on its own" (`ProviderTurnSupervisor.wakeEvidence.test.ts`), "asks, and never sends, once an idle thread stayed quiet for 120 s" and "counts the quiet time from the latest progress, not only from wake" (`policy.logic.test.ts`), and the extended "observes a provider that continued on its own and sends nothing" (`recovery.test.ts`).
2. **Post-wake restart prompt invisible.** The coordinator's `findThread` now loads a thread that is not in the read model through the engine's `ensureThreadState`, so `publishRecovery` and `evaluateIntent` reach a thread whose session was persisted stopped. This replaces widening the startup window: intents suspended at exit are never pruned, so a predicate on them would grow the startup load forever. The per-thread operational query (`threadSql`) has no such predicate and needed no change. Test: "shows the post-wake restart prompt on a thread outside the startup window" (`restart.test.ts`).
3. **fd 5 was assumed.** The fd 3 envelope gains an optional `lifecycleHintFd` (`DesktopLifecycleHintFd` in `server/desktopLifecycleHint.ts`). The desktop sends it when spawn opened the sixth stdio pipe, and the server reads the announced fd only. A desktop envelope without it starts no reader and logs once; the other sleep sources still work. An older desktop with a newer server gets no hints, which is acceptable. This supersedes Thread S note 18. The desktop pins its local constant to the contract by type, because it cannot import the contracts value at runtime (Thread N note 7): `bun typecheck` fails if either number changes alone. Tests: "reads the hint pipe only when the envelope announces it" and "decodes the start reason with and without the hint pipe" (`cli-config.desktopLifecycle.test.ts`), "decodes the announced hint fd and rejects a negative one" (contracts), "announces the lifecycle hint fd only when spawn opened the pipe" and "keeps the local hint fd equal to the contract the server reads" (desktop).
4. **Provider calls under the single permit.** Inspection and Stop and continue's interrupt and stop now run through `RecoveryContext.outsidePermit`, which releases the coordinator's permit for the call and takes it back. Afterwards the intent is read again, and nothing is done unless its revision is unchanged. Inspection results are cached per intent revision. `stopSession` has a 10 s timeout. When the provider neither answers the interrupt nor stops in time, or the stop fails, nothing is sent, and the prompt stays for the user. Tests: "a slow inspection never holds up event observation", "a revision change during inspection prevents the stale action", "a failed stop leaves the prompt asking the user" and "a stop that never answers times out and leaves the prompt asking the user" (`permit.test.ts`).
5. **Per-pass starvation.** The pass lists only statuses that move on by themselves (`interrupted-by-sleep`, `observing`, `continuing`, `provider-continued`). Prompts whose decision provider activity can still change (`awaiting-user` with reason `no-activity-after-wake`) come from a separate query, newest first, at most 50. Other prompts and `parked` are not re-inspected. A completed turn still settles a waiting prompt through `turn.completed`; a parked one waits for Retry or Dismiss, as before. The backend start and the sleep-epoch sweep page through every candidate (`ProviderTurnSupervisor.intents.ts`, cursors on `listActive` and `listUncertainAfterRestart`). The existing `(disposition, recovery_status, updated_at)` index serves these queries, so no migration was added. Tests: "a new cut turn is evaluated behind more old prompts than one page holds", "an ordinary start suspends more leftovers than one page holds", "a post-wake restart prompts for more uncertain turns than one page holds" and "the newest 'no activity' prompt still sees the provider continue" (`paging.test.ts`).
6. **Reattach state not reset.** Once the agent answers an attach, `RemoteAgentReattachRecovery.reset` restores the three immediate attempts and the backoff, and counts the 24 h deadline from that contact. Attach request IDs keep a separate count that never resets, so they stay unique. Test: "gives a second drop its immediate attempts again after a successful reattach" (`remoteAgentProcessClient.sleep.test.ts`).
7. **A stale completion settled a newer intent.** A completed turn settles an unbound intent only when the coordinator saw that turn start after the intent was accepted (`completionBelongsToIntent`, using the `turn.started` time now kept in the tool tracking). An unbound continuation never settles on a completion, so it can still bind. Tests: "a normally completed turn settles its intent", "the previous turn's late completion leaves a queued prompt's intent open", "the cut turn's late completion never settles the seeded continuation" and "an unbound intent settles when its own turn completes before it binds" (`settle.test.ts`).
8. **Banner key collisions.** The web state key now includes `attempt`, for the first-seen clock and for dismissal. That alone did not separate the red banners: user-authorized tries never raise `attemptCount`, so two failed Continue clicks shared a key. The projected `attempt` therefore also counts user-authorized tries (`detail.userAttemptCount`). Parking still counts automatic attempts only, so "Couldn't resume after N tries" now counts every try. Tests: "keys each try apart, so a later try gets its own 3 s hide and dismissal" (web unit), "hides each new try for 3 s and shows a later failure after an earlier one was closed" (browser) and "a user's repeated Continue shows a new try each time and never parks" (`noticeSync.test.ts`).
9. **A failed `may-have-been-sent` write looked possibly sent.** The write failure is now `ProviderDispatchAttemptPersistenceError`, part of `ProviderServiceError`, and `provenBeforeDispatch` treats it as before dispatch, because the send is never invoked. The `as ProviderServiceError` cast in `sendTurn` is gone; the error union now checks without it. Test: "reports a failed may-have-been-sent write as proven before dispatch" (`ProviderService.sendTurn.test.ts`).
10. **"No activity since wake" during an approval.** A pending approval or user-input request (`isThreadWaitingForUser`) counts as the provider still working. A turn waiting for one is not moved to `observing` at wake, and an observed turn that waits for one becomes `provider-continued`, never the amber prompt. Tests: "a turn waiting for an approval across the sleep is never 'no activity'" and "an observed turn that then waits for an approval counts as still working" (`wakeEvidence.test.ts`), and "treats a pending approval or answer as the provider still working, not silence" (`policy.logic.test.ts`).
11. **Docs.** The conformance README and `scripts/lib/sleep-wake-probe.types.ts` no longer say the clock stops on macOS. The connection resilience plan's status line points to its Phase 6 and to this plan. The README's first runs section has a table of what each run should show on a build with this plan. The probe does not detect those states; the user reads them from the thread.

Remaining risk from this round: a failed `may-have-been-sent` write whose database message reads like a dead connection is now classified `session-dead`, so dead-thread recovery restarts the session and tries the send again. That is safe, because nothing was sent, but a broken database will fail the retry the same way.

### Third review fixes

Recorded on 23 October 2026, after a third review of the committed feature. Numbers follow that review. Each code fix has a regression test that fails without it. None of them changes the invariant: reconcile before continuing; never blindly replay potentially accepted work.

- **11. A pending suspend never expired.** A desktop `suspend` hint now counts for a resume only within 10 minutes (`DESKTOP_PENDING_SUSPEND_MAX_AGE_MS`). Gap detector and supervisor clock evidence also use up a pending suspend: one within 60 s before the measured start widens the evidence to it, and an older one is dropped, because the server ran after it. A longer real sleep loses nothing, since those sources measure its start. Tests: "drops a pending suspend too old to belong to the resume" and the `consumePendingSuspend` cases (`SystemSleepEpochs.sources.logic.test.ts`), and "never stretches a later sleep back to an aborted suspend" (`SystemSleepEpochs.test.ts`).
- **12a. Resolve trusted a stale projection.** `resolveRecovery` now checks the intent's own `recoveryStatus` against the same table the decider uses (`isRecoveryActionApplicable` in `deciderThreads.recovery.ts`). When the action does not apply, it only resyncs the notice. A second Continue on a `continuing` intent no longer replaces its `continuationMessageId`. Test: "a Continue on an intent that is already continuing keeps its continuation" (`ProviderTurnSupervisor.resolveActions.test.ts`).
- **12b. A failed notice publish stayed hidden.** A failed `thread.recovery.set` (publish or clear) is kept in memory (`unpublishedNotices`, bounded), and every recovery pass publishes it again from the intent's current state. A notice that already matches its intent is not sent again (`sameThreadRecovery`). Only failed publishes are retried, so prompts nobody answers cost nothing per pass. Test: "republishes a prompt whose publish failed, so it never stays hidden" (`resolveActions.test.ts`).
- **13. Acknowledgement had no guard.** The acknowledge `UPDATE` now also matches the thread, the message and `state = 'may-have-been-sent'`, and uses `RETURNING`, as the cleanup repositories do. When no row changed (a missing, pruned or already acknowledged attempt), it fails, so the writes alongside roll back and the existing fallback writes liveness and the binding without it. `recordAcceptedSendTurn` now acknowledges even without a liveness repository; the binding alone rides with it. Tests: "acknowledgement rolls back when the attempt update itself fails" and "acknowledges only an attempt that may have been sent, and only once" (`ProviderDispatchAttempts.test.ts`), and "acknowledges with the binding even without a turn liveness repository" (`ProviderService.sendTurn.record.test.ts`).
- **14. A short synchronous write broke line framing.** The Linux suspend write now writes bytes and reads the count. On a short write the rest follows through the normal stream write, so the line stays whole. Zero bytes written falls back to the queued write of the whole line. Test: "writes the rest of a short synchronous write through the stream, keeping the line whole" (`backendLifecycleHintPipe.test.ts`).
- **15. A delayed reattach could not be stopped.** `RemoteAgentProcessRunInput` and `attach` take an optional `signal`. `beforeAttempt` returns `cancelled` when it aborts, also in the middle of the wake or backoff wait, and the client checks it again after connecting. A cancelled reattach ends with `PROCESS_REATTACH_CANCELLED` and the new outcome `cancelled`, not "outcome unknown", and it never sends a `processRequest`. The owned runner no longer treats every non-unknown outcome as terminal, so a cancelled owner stays `outcome-unknown` and pinned. The shell runner and the git executor pass the abort signal of their `Effect.tryPromise`, so interrupting the turn ends the wait. The backoff timer is unref'd. The tool runner has no cancellation in its call chain and is unchanged. Tests: "ends a delayed reattach as cancelled once the turn is stopped, and never respawns", "does not reconnect at all when the turn was stopped before the link dropped" and "never keeps the server alive with its backoff timer" (`remoteAgentProcessClient.cancel.test.ts`).
- **16a. Compaction could expire a running operation.** The journal now remembers the operations this process accepted and has not completed, and compaction never expires those. An operation left running by an earlier agent process has no completion record (restore expires it in memory as `AGENT_RESTARTED`), so its acceptance-time retention still applies and the journal cannot fill up across crashes. The old test "compaction discards expired operations" now uses a finished operation, which is what that expiry is for. Test: "compaction_keeps_a_running_operation_past_its_acceptance_retention" (`compact.tests.rs`).
- **16b. A cursor at `u64::MAX` overflowed.** `replay_from` uses `saturating_add`. A grep of the crate found no other arithmetic on a client-supplied sequence: process and PTY acknowledgements only compare, PTY replay already saturates, and the supervisor attach cut uses `saturating_sub` and `max`. Tests: "a_cursor_at_u64_max_replays_nothing_instead_of_overflowing" (`operations/tests.rs`) and "a_session_attach_with_a_cursor_at_u64_max_does_not_overflow" (`process_attach.tests.rs`).
- **18. Missing tests added.** Retry from parked, Keep waiting, and the Stop and continue positive path ("Retry from parked sends one user-authorized continuation", "Keep waiting restarts the awake clock and sends nothing", "Stop and continue stops the provider turn, then continues once", `resolveActions.test.ts`). The `thread.prompt-queued` settle path, with and without `alreadySent` (`OrchestrationEngine.recoveryIntents.promptQueued.test.ts`). `readSleepContinuationEnabled` parsing (`ProviderTurnSupervisor.state.test.ts`). "a post-wake restart after a crashed backend prompts, never sends" (`restart.test.ts`). "publishes a detected sleep to SystemSleepEpochs as server-gap evidence" (`EventLoopLagMonitor.test.ts`). `tool.updated` keeps `itemId` (extended "keeps the runtime item ID on tool lifecycle activities so start and end pair up"). A `backendManager` test with mocked spawn: "spawns with six stdio entries and announces the fd 5 hint pipe" and "marks only the start after an unresponsive restart as a resume-probe restart" (`backendManager.test.ts`). "a_running_operation_older_than_600_seconds_is_attachable_through_a_session_attach" (`process_attach.tests.rs`). "survives a broken pipe: a throwing or failing write closes it quietly" (`backendLifecycleHintPipe.test.ts`). Browser tests for Dismiss on `backend-restarted-after-wake`, Continue on `continuation-failed`, the banner going away when `recovery` becomes null, and closing the notice by keyboard (`ThreadSleepRecoveryNotice.browser.tsx`). The envelope `startReason` decode test from the second round already existed.
- **19. Per-thread memory was only bounded.** When a turn ends normally or as interrupted or cancelled, the coordinator drops the thread's tracking, progress and completion times, held failure and inspections, but only when no tool of that turn is open and the thread has no open intent. An open intent keeps them, because classification and the tool check still read them. `thread.deleted` drops everything for the thread, failed notices included. Tests: "forgets a thread's evidence once its turn ends with nothing open", "keeps the evidence while a tool of the ended turn is still open", "keeps the evidence while another intent of the thread is still open" and "forgets everything, failed notices included, when the thread is deleted" (`ProviderTurnSupervisor.memory.test.ts`).
- **20. A user's `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` reached Claude Code.** `buildClaudeQueryOptions` removes it from the environment given to the SDK, which replaces the CLI's environment entirely. Test: "drops a user's own CLAUDE_CODE_RESUME_INTERRUPTED_TURN from the CLI environment" (`Adapter.session.options.subagentCaps.test.ts`).
- **21. fd 3 to 5 in provider grandchildren: no leak, no change.** A local experiment spawned a middle process with fds 3, 4 and 5 as sockets (as the desktop does), opened fd 5 the way the server does, then spawned a grandchild with `child_process.spawn` and default stdio. The grandchild had none of the three sockets, on macOS (Node 25.2.1, libuv 1.51.0; and Electron 40.6.0's Node 24.13.1) and on Linux (Docker `node:24-bookworm-slim`, libuv 1.52.1). A `/bin/sh` grandchild reported fds 3 to 5 closed, and a `node-pty` 1.1.0 grandchild did as well. A control run that mapped fds 3 to 5 explicitly showed them in the grandchild, so the probe detects a leak. Not checked: Windows, and providers that start children by other means than Node's `child_process` or `node-pty`.
- **22. Nits.** The coordinator reads a tool row's `itemId` by decoding `ToolActivityPayload` (only `tool.started` and `tool.completed` rows are decoded), instead of a cast. Test: "pairs rows by the decoded item ID and counts a malformed one as unmatched" (`tools.logic.test.ts`). The `makeRunStopAll` doc comment is back above the function.

Remaining risk from this round: the tool runner (`tool:` owners) still has no cancellation path, so after a stopped turn its delayed reattach keeps waiting until the 24 h retention ends. Its timers no longer keep the process alive, and those owners are not attributed to a thread, so recovery does not count them.
