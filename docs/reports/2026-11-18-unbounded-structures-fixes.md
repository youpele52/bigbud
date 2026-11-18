# Unbounded structures: fixes for F-B1..F-B10

**Date:** 18 November 2026
**Source:** [Remote backend measurements and bounds audit](2026-11-18-remote-backend-measurements.md),
"Left as findings"
**Status:** 9 of 10 fixed (F-B1, F-B2, F-B3, F-B5, F-B6, F-B7, F-B8, F-B9 here; F-B4 later in
[read-model eviction](2026-11-18-read-model-eviction.md)). F-B10 did not reproduce.

Each fix adds a named limit with its overflow behaviour documented at the constant. The rule
applied throughout: preview and telemetry data may be dropped with a visible gap; ordered
provider events and request replies are never dropped silently (backpressure or a visible
failure instead).

## Fixed

### F-B1: per-client thinking-delta backlog

- **Root cause.** Each WebSocket client subscribes to the shared provider runtime-event
  `PubSub.unbounded` (`ProviderService.ts:101`) through `makeThinkingActivityDeltaStream`. A slow
  client stalls its own subscription, and the PubSub keeps every provider event for it.
- **Bound.** `THINKING_DELTA_CLIENT_BACKLOG_CAPACITY = 512` deltas per client
  (`ws/thinkingDeltaBacklog.ts`). A separate fiber drains the subscription into a dropping
  queue, so the shared PubSub never waits on a client.
- **Overflow.** Newer deltas are dropped. The next delta delivered for the same activity starts
  with `THINKING_DELTA_GAP_MARKER`, so the preview shows the gap. No durable data is lost:
  ingestion persists the thinking activity from the same provider events, and the web
  reconciles to it.
- **Not changed.** The PubSub itself stays unbounded. Its other subscribers are in-process
  reactors that consume promptly, and they carry ordered state, so they must not drop. A guard
  test asserts that `ProviderService.ts` is the only unbounded runtime-event PubSub left.
- **Test.** `ws/thinkingDeltaBacklog.test.ts`: 1,000 deltas reach a stalled client. The shared
  PubSub stays empty, the client receives at most the backlog bound, the prefix is in order, and
  the next delta carries the gap marker.

### F-B2: idle per-thread workers

- **Root cause.** `ProviderRuntimeIngestion` (`threadWorkers`) and `ProviderCommandReactor`
  (`aggregateWorkers`) each kept one fiber and one queue per thread or aggregate, and never
  removed them.
- **Bound.** `orchestration/keyedDrainableWorkers.ts`. A worker idle (nothing queued, nothing
  running) for `KEYED_WORKER_IDLE_TTL_MS = 5 min` is closed by a sweep every
  `KEYED_WORKER_SWEEP_INTERVAL = 1 minute`. The next item for that key creates a fresh worker.
- **Correctness.** The pending count rises in the same synchronous step that looks up the
  worker, and a new worker is created already reserved, so nothing can be enqueued on a worker
  that is being closed. Per-key order holds because the old worker had finished everything.
  `drain` covers every live worker. Workers inherit the creating fiber's context, as before;
  each item runs with the pool's own `Scope` (never the evictable worker's), so work an item
  forks outlives an evicted worker. (A first version replaced the context with services captured
  at construction; that broke the project-delete cascade tests and was corrected.)
- **Not changed.** The checkpoint reactor's single worker queue (one queue, not one per thread).
  Queue depth per worker stays unbounded on purpose: it carries ordered provider events, and
  backpressure is applied earlier, at the adapter (F-B3).
- **Test.** `orchestration/keyedDrainableWorkers.test.ts`: 500 keys are evicted only after the
  TTL and recreated on demand in order. A worker with queued or running items is never evicted.

### F-B3: adapter event queues

- **Root cause.** Claude, Copilot, Pi, OpenCode v1 and ACP used `Queue.unbounded`; Devin, Cursor
  and Muse used `PubSub.unbounded`.
- **Bound.** `PROVIDER_ADAPTER_EVENT_QUEUE_CAPACITY = 256` (`provider/providerEventQueueBounds.ts`),
  the capacity Codex and OpenCode v2 already used. Every one of these adapters now builds its
  queue through `makeProviderAdapterEventQueue` / `makeProviderAdapterEventPubSub`.
- **Overflow.** Backpressure (`suspend`), never dropping. Every producer uses the effectful
  `Queue.offer`, `offerAll` or `PubSub.publish`, so a full queue suspends it until the
  ProviderService monitor catches up. The pause reaches the provider's own transport.
- **Test.** `provider/providerEventQueueBounds.test.ts`: the producer waits at 256, and all 768
  events arrive in order. A source guard fails if any adapter reintroduces an unbounded
  runtime-event queue or PubSub.

### F-B5: partial-line buffers

- **Root cause.** Pi `RpcProcess.ts` `stdoutBuffer` and Codex's `readline` interface buffered an
  unterminated record without limit.
- **Bound.** `PROVIDER_STDIO_MAX_LINE_BYTES = 64 MiB` (`provider/providerStdioLineLimit.ts`), far
  above any legitimate record.
- **Overflow.** `ProviderStdioLineTooLongError`, a visible protocol error. Pi fails its lifecycle
  (pending requests reject with the error), stops buffering, and kills the child. Codex closes
  `readline`, runs its error path (session `error`, `process/error` event, pending requests
  rejected), and kills the child.
- **Refactor.** Pi framing moved to `Pi/RpcProcess.stdout.ts`, which also stops re-scanning the
  buffer from the start for each line.
- **Test.** `provider/providerStdioLineLimit.test.ts`: the guard counts only bytes since the last
  newline, across chunks. The Pi reader frames records, fails exactly once on a 10 MiB runaway
  record, and delivers nothing after it. The Codex wiring shares the guard. It is covered by
  typecheck and the Codex lifecycle, handler and startSession suites, not by its own test,
  because its limit is not injectable.

### F-B6: unclaimed remote-agent frames

- **Root cause.** A frame no listener consumed and no waiter matched was pushed onto
  `queuedFrames` without a cap. `remoteAgentConnection.ts` was at 400 lines.
- **Split.** Frame routing (listeners, waiters, unclaimed set) moved to
  `remote-agent/remoteAgentConnection.inbox.ts`. The connection dropped from 400 to 359 lines.
- **Bound.** `REMOTE_AGENT_UNCLAIMED_FRAME_CAPACITY = 1,024` frames.
- **Overflow.** Unclaimed frames can be replies a caller will still collect, so they are never
  dropped. Overflow `disconnect`s the connection with a protocol error instead: waiters and
  failure listeners see it, and the pool reconnects. Late PTY frames are still discarded as
  before.
- **Test.** `remote-agent/remoteAgentConnection.unclaimed.test.ts`: frames up to the cap stay
  collectable. One more fails the connection visibly, a pending waiter rejects, and stdin is
  closed. `remoteAgentConnection.ptyLateFrames.test.ts` now reads the inbox count.

### F-B7: crash-left temp directories

- **Root cause.** `bigbud-orchestration-mcp-*`, `bigbud-pi-orchestration-*` and `bigbud-v2-exec-*`
  are removed only by session cleanup, which a crash skips.
- **Bound.** `startup/tempDirSweep.ts`, forked in the background after startup is ready. A
  directory is removed only when every check passes:
  1. it sits directly in the temp directory, with an exact prefix and a 6-character `mkdtemp`
     suffix;
  2. it is a real directory (not a symlink) owned by this user;
  3. it has been unmodified for at least 1 hour;
  4. for bridges, the bridge file exists and the owner is gone. Bridges now write
     `.bigbud/owner.json` holding their pid, and a dead pid means the owner crashed. A bridge
     without the marker (from an older version) must be older than
     `LEGACY_BRIDGE_MIN_AGE_MS = 7 days`.

  A run removes at most `TEMP_DIR_SWEEP_MAX_REMOVALS = 256` directories. A live backend's bridges
  are never removed (its pid is alive), and a V2 command sandbox lives at most its 30 s timeout.

- **Caveat.** Pid liveness assumes the temp directory is not shared across pid namespaces.
- **Test.** `startup/tempDirSweep.test.ts`. Nothing fresh is removed. After 2 hours the crashed
  bridge and the sandbox are removed, while the live owner, the marker-less bridge, a name
  without a bridge file, an unrelated directory and a symlink are kept. After a week the legacy
  bridge is removed too.

### F-B8: SQLite space reclaim

- **Root cause.** Freed pages go back to the file system only in `auto_vacuum` `INCREMENTAL`
  (or `FULL`) mode. Every database was created in `NONE`, so only the user-confirmed rebuild
  could switch it.
- **Fix.** `persistence/Layers/Sqlite.autoVacuum.ts`. Before WAL or migrations, an empty
  database file (`page_count = 0`) is set to `INCREMENTAL`. From then on, the existing bounded
  steady-state step (`PRAGMA incremental_vacuum(1024)` when free pages exceed 10%) reclaims
  space with no rebuild.
- **Existing databases stay as they are.** Switching them needs a full `VACUUM`, which blocks
  writes for its whole duration and needs disk for a copy, so it stays the user-confirmed
  rebuild.
- **Compatibility.** The rebuild, the steady-state step, and `VACUUM INTO` backups work
  unchanged on an incremental database. A restored backup in either mode follows the same
  steady-state rule. `journal_size_limit` was already applied when `DatabaseCompaction` is built
  at startup, as well as in the steady-state step.
- **Test.** `persistence/Layers/Sqlite.autoVacuum.test.ts`: on a fresh database, freed pages
  (>300) are released by the steady-state pragma. On an existing database the mode is left
  unchanged.

### F-B9: git status entries per cwd

- **Root cause.** `GitStatusBroadcaster` created an entry (PubSub plus refs) for every cwd ever
  subscribed to or invalidated, and never removed it.
- **Bound.** Entries now live only while their cwd has subscribers. The subscription holds the
  entry through `acquireRelease` for the stream's lifetime, and the last subscriber removes it
  and shuts down its PubSub. `invalidateLocal` for a cwd with no subscribers runs no git command.
- **Remote cache.** The newest remote status of at most
  `GIT_STATUS_RETAINED_REMOTE_CWD_CAPACITY = 256` cwds is kept (least recently refreshed evicted
  first), so a returning subscriber's snapshot still shows ahead/behind counts.
- **Test.** `git/Layers/GitStatusBroadcaster.eviction.test.ts`: 300 cwds subscribed and left
  leave 0 entries. An unobserved invalidation creates nothing. A returning subscriber sees the
  retained remote status, and the oldest cwd past 256 sees `null`.
  `GitStatusBroadcaster.backlog.test.ts` still passes.

## Left as findings

### F-B4: the read model keeps every thread it has loaded (fixed later)

**Update:** fixed by migrating single-thread reads to a reload-on-miss accessor and evicting idle
threads; see [read-model eviction](2026-11-18-read-model-eviction.md). The analysis below is the
original finding.

Evicting a hydrated thread from `OrchestrationEngine`'s read model would be correct only for
consumers that rehydrate on demand. There are about 95 direct `readModel.threads.find` lookups
in orchestration, provider and ws code, against 15 `ensureThreadState` calls. Ingestion,
reactors and tool dispatch read the read model directly.

A thread whose session is idle (`ready`) is not "operational" by the startup predicate
(`ProjectionOperationalStateQuery.sql.ts`), yet its provider process may still be alive and
emitting events. Evicting it would make those lookups miss, and runtime events for it would be
dropped. Matching the startup predicate in memory would also need watches, delegations and
recovery intents, which live in other tables.

Proposed approach: route the remaining direct lookups through the hydrator first. Then evict
least-recently-used threads that a per-thread SQL check (the startup predicate filtered by id)
shows are not operational and that have no live provider session, under the command semaphore,
clearing `historyLoaded` as well.

### F-B10: session status after `thread.session.stop` (not reproduced)

An investigation (scratch tests kept outside the repo under the job's private tmp `fb10/`) did not reproduce
it:

- The test adapter, a completed turn, then stop: `projection_thread_sessions.status` was
  `stopped` after 42 ms.
- The real CodexAdapter running the measurement's fake codex, with 1 or 4 threads (3 turns
  each), then stop (also stop followed by delete, as the tool does): `stopped` within 131–293 ms.

The "30 s" most likely is the tool's own `CLEANUP_DEADLINE_MS = 30_000` deletion wait, meaning
the status never changed while the tool waited rather than changed late. The backend journal of
the measurement run ends before cleanup, so there is no evidence of the actual failure.

Most likely cause: in `ProviderCommandReactorHandlers.session.responses.ts`, the idle branch
projects `stopped` only after `providerService.stopSession` succeeds. A failed stop (for example
the epoch check in `resolveRoutableSession`, or a missing binding) is only logged, with no retry.
On arm64, deletion cannot cover for it either (F-B11).

Next step: rerun the measurement on arm64 with the journal captured through cleanup, and look
for `provider command reactor failed to process event` with `eventType:
thread.session-stop-requested`.

Also seen: after a stop followed by a delete, the stop's `setTurnControlOperation` is rejected by
the deletion fence, so the operation stays non-terminal if the deletion later aborts.

## Change groups (one commit each)

1. F-B1: `ws/thinkingDeltaBacklog.ts` (57 lines), `ws/thinkingDeltaBacklog.test.ts` (72),
   `ws/wsStreams.ts` (271).
2. F-B2: `orchestration/keyedDrainableWorkers.ts` (134), `keyedDrainableWorkers.test.ts` (56),
   `orchestration/Layers/ProviderRuntimeIngestion.ts` (367), `ProviderCommandReactor.ts` (197).
3. F-B3: `provider/providerEventQueueBounds.ts` (26), `providerEventQueueBounds.test.ts` (57),
   and the adapters: `Claude/Adapter.events.ts` (40), `Copilot/Adapter.ts` (335),
   `Pi/Adapter.ts` (159), `Opencode/Adapter.ts` (108), `Devin/Adapter.ts` (312),
   `Cursor/Adapter.ts` (314), `Muse/Adapter.ts` (154), `acp/AcpSessionRuntime.ts` (266).
4. F-B5: `provider/providerStdioLineLimit.ts` (50), `providerStdioLineLimit.test.ts` (41),
   `Pi/RpcProcess.ts` (389 → 376), `Pi/RpcProcess.stdout.ts` (63),
   `codex/codexAppServerManager.handlers.lifecycle.ts` (92).
5. F-B6: `remote-agent/remoteAgentConnection.ts` (400 → 359), `remoteAgentConnection.inbox.ts`
   (94), `remoteAgentConnection.unclaimed.test.ts` (63), `remoteAgentConnection.ptyLateFrames.test.ts`
   (98).
6. F-B7: `startup/tempDirSweep.ts` (139), `tempDirSweep.test.ts` (66),
   `startup/serverRuntimeStartup.ts` (379), `orchestration-tools/orchestrationMcpBridge.ts` (250),
   `orchestration-tools/PiOrchestrationBridge.ts` (54).
7. F-B8: `persistence/Layers/Sqlite.autoVacuum.ts` (31), `Sqlite.autoVacuum.test.ts` (51),
   `persistence/Layers/Sqlite.ts` (145).
8. F-B9: `git/Layers/GitStatusBroadcaster.ts` (218), `GitStatusBroadcaster.eviction.test.ts` (73).
9. This report.

All paths are under `apps/server/src/` except this report. Every touched file has 400 lines or
fewer.

## Checks

- `bunx oxfmt --check` and `bunx oxlint` on the explicit list of 36 changed files: clean.
- `bun run --cwd apps/server typecheck`: 0 errors, and no diagnostics in changed files.
- New tests: 8 files, 12 tests pass.
- Neighbouring suites:
  - All `ProviderCommandReactor*` and `ProviderRuntimeIngestion*` suites: 108 files, 438 tests
    pass.
  - Claude, Copilot, Pi, OpenCode, Devin, Cursor, Muse and ACP suites: 179 files pass and 2 tests
    fail. Both failures also fail with the HEAD versions of the touched files, so they predate
    these changes: `Claude/Adapter.test.ts`, "runs remote Claude workspaces through a local MCP
    bridge" (tool list), and `Opencode/Adapter.session.test.ts`, "runs OpenCode locally against
    a synthetic workspace" (execution target).
  - Pi `RpcProcess` and Codex lifecycle, handler and startSession suites: 5 files, 19 tests pass.
  - Remote-agent connection and pool suites: 7 files, 29 tests pass.
  - Bridge suites and `serverRuntimeStartup`: 5 files, 22 tests pass.
  - `Sqlite.usage`, migration lag, `ProviderSessionDirectory`, `DatabaseCompaction` and its
    steady-state suite: 5 files, 27 tests pass.
  - `wsStreams` and the git-status backlog suite pass.
- Mutation check: each bound was removed in turn (backups under the job's private tmp
  directory, restored afterwards). Every new test failed under its mutation: B1 drop to suspend,
  B2 no eviction, B3 unbounded queue, B5 guard off, B6 no cap, B7 owner always gone, B8 no pragma,
  B9 no entry removal.
