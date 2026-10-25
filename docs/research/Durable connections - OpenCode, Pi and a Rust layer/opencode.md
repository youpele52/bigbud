# OpenCode: durability model

Research date: 2026-10-21. Upstream baseline: `sst/opencode` (also `anomalyco/opencode`) HEAD `6dfc681835baa5967052d4a1ebd910b49f042b08`, packages at 2.1.2, matching the installed `~/.opencode/bin/opencode` v2.1.2. bigbud pins `@opencode/client` 2.0.26 and `@opencode-ai/sdk` 1.17.13 (`apps/server/package.json:41–42`). Upstream paths below are relative to `packages/` at that commit. Tags: **[V]** verified in code or docs, **[I]** inferred.

## Takeaway

OpenCode's agent is **server-durable**. A long-lived process owns the loop and an event-sourced SQLite database. A prompt is admitted before it runs, a write-ahead claim is stored when a turn starts, and in `--service` mode a turn cut by a restart or crash is resumed on the next boot with a synthetic "continue" message. The live event stream is a separate, weaker thing: it has no ids and no replay, and a client that disconnects re-fetches state and subscribes again. The agent keeps working because the process that owns it is still there, not because any client socket stayed open.

## How the agent survives

Mapped onto the same steps as [Pi Durable](https://earendil.com/posts/pi-durable/), so the two designs can be compared as agents.

- **Admit.** `POST /api/session/:id/prompt` writes the input to `session_inbox` before the loop runs. The HTTP call returns at admission. [V: `protocol/src/groups/session.ts:335–355`]
- **Claim.** Starting a turn sets `session_v2.time_suspended`. Shutdown keeps the claim. [V: `core/src/session/execution.ts:71–139`]
- **Resume by asking the model, not by rewinding a task.** On a service-mode boot, `resumeSuspendedSessions` appends "The server restarted while you were working. Continue from where you left off without repeating completed work." and runs the loop again. `resume_attempts` is durable; after 10 the session fails. [V: `core/src/session/execution/restart.ts`; `core/src/session/store.ts:63–85`, `:197–250`]
- **No per-tool replay flag.** A tool that had started can run again, because the model is simply told to continue. The code warns about repeated external side effects. An open content block's partial text is not in the database. [V: comments and `projector.ts:325`; I for the lost partial]
- **The client is optional.** Disconnect does not interrupt the fiber. Only `session.interrupt` or shutdown does. [V: `core/src/session/run-coordinator.ts:67–92`]
- **Only the service daemon does this.** Plain `opencode serve` does not install restart continuity. [V: `cli/src/server-process.ts:145–159`]

## What is persisted, where and when

- **One SQLite database** in WAL mode: `~/.local/share/opencode/opencode.db` (10.7 GB on this machine), with `session_v2`, `session_message`, `session_inbox`, `event` and `event_sequence` plus legacy v1 tables. The older `storage/` JSON tree is a v1 import source only. [V: read-only `.schema`; I for the import role, `core/src/database/v1-migration*.ts`]
- **Every event type is declared durable or ephemeral** in the schema. Durable events get a per-session sequence and commit in one transaction with their projections and the sequence counter. [V: `schema/src/event.ts:37–150`; `core/src/bus.ts:319–440`]
- **Granularity is the content block.** Text, reasoning and tool-progress deltas are ephemeral; `text.ended`, `tool.success`, `step.ended` and similar carry the full value. The schema comment reads: "Stream fragments are live-only; Text.Ended is the replayable full-value boundary." A crash mid-block loses that block's partial text. [V: `schema/src/session-event.ts:417–418`, `:457`, `:501`, `:534`, `:608`; I for the loss]
- **Prompts are admitted before execution.** `POST /api/session/:id/prompt` "durably admit[s] one session input and schedule[s] agent-loop execution"; queued input lives in `session_inbox` with `enqueued_seq`. [V: `protocol/src/groups/session.ts:335–355`, `:546`]
- **Raw event payloads are not kept locally.** `Bus` defaults to `persist: false`; only the Cloudflare host enables it. The local DB has 23 `event` rows against 12 475 `event_sequence` rows. [V: `core/src/bus.ts:208`; `server/src/workerd.ts:69`; `cli/src/server-process.ts:100–162`; row counts]

## How a client reconnects and resumes

- **`GET /api/event` is live-only.** Frames are `data:` with no `id:` line, so there is never a `Last-Event-ID`. Each connection opens with `server.connected` and gets a `: heartbeat` comment every 15 s. Each subscriber has a 4 096-entry queue; overflow fails that stream. The API text says: "Volatile by contract: a slow consumer overflows and fails the stream, and events during disconnection are missed." [V: `server/src/handlers/event.ts`; `server/src/event-feed.ts:8`; `protocol/src/groups/event.ts:51`; [client docs](https://opencode.ai/v2/docs/build/client): "Subscriptions are live-only, with no replay or automatic reconnection."]
- **A cursor log exists but is empty locally.** `GET /api/experimental/session/:id/log?after=<seq>&follow=` replays from `event`, emits `log.synced`, then follows live. With `persist: false` there is nothing to replay. [V: `protocol/src/groups/session.ts:665–683`; `core/src/bus.ts:834–880`; I for the empty result, not exercised live]
- **Practical resume is re-fetch.** The first-party client reconnects on a 1 s loop with a 45 s idle watchdog; on `server.connected` it re-fetches `session.active()` and drops cached reads. Message history pages by `cursor.next/previous`. [V: `client/src/solid/connection.ts:33–181`; `client/src/solid/data.ts:635–660`; `protocol/src/groups/message.ts:70–90`]
- **SDK 1.17.13 SSE retry** backs off 3 s to 30 s on error only, stops for good on a clean end of stream, and never resets its attempt counter. [V: `@opencode-ai/sdk` `dist/v2/gen/core/serverSentEvents.gen.js:2–127`, `:117`]
- **bigbud already treats the stream as hints.** `EventHub.connection.ts` requires `server.connected` within 2 s and aborts after 45 s idle; `EventHub.ts:245–283` marks sessions dirty on a repeat `server.connected`, failure, overflow or location mismatch; `Runtime.recovery.ts:83–323` repairs by reading messages and `session.active` and never resends an uncertain prompt. [V: `apps/server/src/provider/Layers/OpencodeV2/`]

## In-flight work

| Event                  | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client disconnect      | **Continues.** The prompt call returns at admission; the turn runs in server-owned fibers. Only `session.interrupt` or shutdown stops it. [V: `core/src/session/run-coordinator.ts:67–92`; `protocol/src/groups/session.ts:685–704`]                                                                                                                                                                                                                                                                                                                                                                      |
| Graceful restart       | **Resumed (service mode).** A write-ahead claim is set in `session_v2.time_suspended` when a turn starts and kept on shutdown. On boot `resumeSuspendedSessions` appends "The server restarted while you were working. Continue from where you left off without repeating completed work." and resumes. Attempts are counted durably in `resume_attempts`; after 10 the session fails. Running background shells are reported cancelled; background subagents resume. [V: `core/src/session/execution.ts:71–139`; `core/src/session/execution/restart.ts`; `core/src/session/store.ts:63–85`, `:197–250`] |
| Crash or SIGKILL       | Same path: the claim survives, the next boot resumes. Partial text of the open block is lost and newer steps supersede the stale incomplete row. Delivery is **at-least-once**; the code warns about "repeated external side effects after a crash". [V: code and comments; `projector.ts:325`; I for partial-text loss]                                                                                                                                                                                                                                                                                  |
| Plain `opencode serve` | No restart continuity: `installRestartContinuity` runs only when the CLI passes `lifecycle`, which it does only for `--service`. Orphaned claims wait for a service-mode boot on the same DB. [V: `server/src/process.ts:107–110`, `:234–242`; `cli/src/server-process.ts:145–159`; I for the orphan behavior]                                                                                                                                                                                                                                                                                            |
| Laptop sleep           | No power handling in core or server. [V by grep] The process freezes; after wake a cut model stream goes through normal step failure and `retry.scheduled`, not restart recovery, because the process never exited. [I]                                                                                                                                                                                                                                                                                                                                                                                   |

## What `opencode serve --service` is

The CLI's managed background daemon. [V: `cli/src/server-process.ts`; `cli/src/services/service-config.ts`; `cli/src/services/service-registration.ts`; `client/src/effect/service.ts`]

- **Stable endpoint.** Channel-derived fixed port (0xC0DE = 49374 for latest, dev and beta) and a persisted password in `~/.config/opencode/service.json`.
- **Single instance.** A second start exits quietly if a healthy compatible server holds the port, and retries `EADDRINUSE` for 15 s.
- **Discovery.** After listening it atomically writes `~/.local/state/opencode/service.json` (id, version, url, pid, password; 0600), re-checks it every 5 s and exits if replaced. This machine's file shows v2.1.2 on `127.0.0.1:49374`.
- **Client lifecycle.** `Service.ensure()` spawns it detached, replaces a version mismatch and kills one that times out three times. `opencode service start|stop|restart|status` manage it.
- It is the only mode with boot-time turn resume and persistent-PTY handover.

Because bigbud's V2 integration borrows this shared daemon rather than spawning it (`docs/reports/providers-opencode-v2.md:3`), **OpenCode V2 turns survive a bigbud backend crash**; bigbud reattaches and reconciles.

## Known weaknesses

1. Live stream: no ids, no replay, overflowing subscribers dropped, deltas never stored. [V]
2. The session-log cursor replays nothing locally because `events.persist` is off. [V config, I behavior]
3. Restart resume is at-least-once by re-prompting the model, so tool side effects can repeat; it exists only in service mode. [V]
4. The 1.17.x SDK SSE loop ends permanently on a clean close and its backoff never resets. [V]
5. Version skew: bigbud's `@opencode/client` 2.0.26 against a 2.1.2 server. [V]
6. Related closed v1.17-era issues, not re-checked on v2: [#36804](https://github.com/anomalyco/opencode/issues/36804) (serve-mode session stuck busy after a dropped tool dispatch), [#31281](https://github.com/anomalyco/opencode/issues/31281) (large tool output stalls SSE), [#25137](https://github.com/anomalyco/opencode/issues/25137) (MCP session not re-established after restart).

## New relative to earlier bigbud notes

`docs/research/OpenCode API integration assessment/bigbud-requirements.md:52`, `:109` already record the live-only stream and the experimental session log. New here: local `events.persist` is off, so the log has no history; service-mode boot recovery (write-ahead claim, synthetic continue message, 10-attempt budget); and that only service mode has it.
