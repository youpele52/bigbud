# F-B4: bounded orchestration read model (eviction with transparent rehydration)

> **Reverted on 18 November 2026; re-land prepared on 19 November 2026 (not committed).** The
> live re-run ([report](2026-11-18-unit-only-fixes-live-rerun.md)) saw the backend wedge under
> 3–8 concurrent provider sessions with this change (D-1), and `e84335fe60` was reverted. The
> wedge was then traced to a pre-existing lock-order inversion between the provider session
> directory's write lock and the SQLite connection (in the code since `07356fbac1`; current dev
> wedges without eviction too). Eviction only made it more likely. With that fixed, the eviction
> build completes 1/4/8 sessions and still bounds the read model
> ([report](2026-11-19-d1-eviction-wedge-and-d2-d3-live.md)). The re-land also carries F-1 (one
> sweep per interval).

**Date:** 18 November 2026
**Source:** [Unbounded structures: fixes](2026-11-18-unbounded-structures-fixes.md), F-B4; the shared
hydrator from [P8 live acceptance, "Fixes and re-run"](2026-11-18-p8-live-acceptance.md).
**Status:** Fixed. Eviction is enabled. Not committed.

## Problem

`OrchestrationEngine` kept every thread it ever hydrated in its in-memory read model. The startup
window loads only operational threads, but any later command, reactor, tool or WebSocket lookup
that hydrated a settled thread left it resident for the life of the process.

Eviction was unsafe because most consumers read `getReadModel().threads.find(...)` directly: an
evicted thread would look absent, and events for it would be skipped.

## Approach

1. Every read of the read model's threads was inventoried and classified (below).
2. One shared accessor was added on top of the existing hydrator.
3. Every by-id lookup outside the command barrier was migrated to it. Each remaining direct read
   has a stated reason why it stays complete under eviction.
4. Eviction was then added. It has a named bound, an idle TTL, in-memory guards, outside holds
   and a per-thread SQL check equal to the startup predicate.

The invariant that makes this safe: an evicted thread is always one that a restart would also
have left out of the startup window. So any whole-model scan that is correct after a restart is
still correct after eviction, and any by-id read hydrates on a miss.

## Inventory (non-test server code)

There are 86 `getReadModel()` reads in 60 files, plus the engine-internal `readModel()` closures
and helpers that receive a read model as a parameter.

| Caller kind                                                                                           | Reads | Outcome                                                                                    |
| ----------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------ |
| Reactors: checkpoint, learning, prompt suggestion, provider command, scheduler, watch, supervisor     | 31    | By-id reads migrated. Scans kept (see "Kept").                                             |
| Ingestion: processor, helpers, tasks, inspection, reconciliation                                      | 10    | By-id reads migrated. The startup and periodic reconciliation scans kept.                  |
| Tools: thread tools, computer use, browser, workspace, create_thread, access                          | 12    | Migrated. Pinned scans kept. The cross-project reference check now reads projected ids.    |
| WebSocket / HTTP: bootstrap, shell dispatch, pin RPC, remote workspace, streams, text generation      | 12    | By-id reads migrated. Project-only and sequence-only reads kept.                           |
| Command barrier: deciders, deletion fence, ownership, metadata generation, workspace transition       | many  | Kept. They run while holding the command semaphore, and eviction needs the same semaphore. |
| Startup and fallbacks: legacy pinned migration, bootstrap submission and peer read without a hydrator | 5     | Kept: startup or test-double fallbacks.                                                    |

### Accessor

In `orchestration/Services/OrchestrationEngine.ts`:

- `getOrchestrationThread(engine, threadId, level = "operational")` is the one by-id read. A
  resident thread is returned as is, without the barrier, so this is identical to the old direct
  lookup. A miss hydrates under the barrier. Engine side: `getThread`. A host without
  `getThread` but with `ensureThreadState` reads the resident thread first, then hydrates
  through `ensureThreadState`.
- `getOrchestrationThreadWithReadModel` returns the thread plus the snapshot it was read from
  (for the snapshot sequence or the thread's project).
- `ensureOrchestrationProjectThreads` hydrates every live thread of a project (project-delete
  cascade).
- `ensureOrchestrationThreadSubtree` hydrates a thread and its live descendants (subtree
  deletion). It uses a new recursive SQL `listThreadSubtreeIds`.
- `listOrchestrationProjectThreadIds` reads the projected ids only, for the cross-project
  reference check, so nothing is loaded.

The engine wiring is in `Layers/OrchestrationEngine.residencyApi.ts`. `ensureThreadState` keeps
its barrier semantics unchanged. The hydrator (`OrchestrationEngine.hydration.ts`) gained `peek`,
`loadThreadSubtree` and `evict`, and records every access by id.

**Why a lookup right after the accessor is safe.** Every accessor call touches the thread, and
eviction never selects a thread touched within `READ_MODEL_MIN_RESIDENCY_MS`. So a synchronous
read of the snapshot that immediately follows (projects, sequence) still finds the thread.

### Migrated call sites: 51 in 35 files

- **Checkpoint reactor** (8): baseline from a runtime turn start, baseline from a domain turn
  start, capture on turn completion, capture from a placeholder, session cwd, path checkpoint,
  and two revert reads. The four that read checkpoints, messages or plans use `history`.
- **Provider command reactor** (9): turn-start backstop, interrupt-continue flush, steer (two
  reads; the separate `resolveThread` dependency was removed), turn-start reconciliation,
  `ensureSessionForThread`, project resolver, project threads, and delete-subtree resolution.
- **Ingestion** (6): event processing, git-repo check, assistant message, plan-implemented
  (`history`), task reads, and inspection replay.
- **Turn supervisor** (4): health update, due inspections (per id, not a scan), inspection
  ownership, and recovery `findThread`.
- **Learning, prompt suggestion, scheduler and watch reactors** (6): the watch reactor has 3.
- **Tools** (13):
  - computer use v1 and v2;
  - create_thread (caller, existing child, updated child);
  - list_available_models;
  - pin and unpin (caller, target, `pinnedAt`);
  - the cross-project reference check;
  - browser routing;
  - agent workspace.
    The last two no longer receive a raw `readModel()` closure; the engine passes itself.
- **WebSocket / HTTP / retention** (6): the pin RPC, remote workspace thread tools, shell
  dispatch, two bootstrap reads, and the retention-delete settle check.

### Kept, with reason

- **Inside the command barrier.** Eviction takes the same semaphore, so nothing is evicted
  during these: deciders and `commandInvariants`, the deletion fence (acquire and release), the
  ownership resolver, metadata generation (`withThreadHistoryBarrier`), workspace admission, the
  workspace-mode gate, and the native coordinator's barrier block.
- **Project-only reads.** Projects are never evicted, and a resident thread's project is
  installed with it: turn-start cwd, text generation, prompt-suggestion cwd, retry and git text
  generation, setup scripts, remote agent restart, and the native coordinator's initial check.
- **Snapshot sequence only.** `wsStreams` and the workspace preflight receipt. The read in
  `ThreadRetention.direct.ts` is unused.
- **Whole-model scans whose subject is never evictable.** Each scanned property makes a thread
  operational (by the SQL predicate, the in-memory guard, or both):
  - turn-start recovery and the watchdog: `pendingTurnStart`;
  - supervisor startup: `recovery`;
  - ingestion startup and periodic reconciliation: a running session, an active turn, or a
    pending interrupt or turn-control operation;
  - turn-control recovery;
  - pinned counts and lists in the RPC and tools: `pinnedAt`;
  - computer-use relevance: an active turn or an activity lease;
  - the runtime-update drain probe: active turns, pending starts, approvals, user input, leases
    and admissions;
  - native workspace sessions: non-stopped sessions;
  - `assertRuntimeStartAllowed` / `isThreadFenced`: ancestor chains stay whole (see the rule).
- **Fallbacks without a hydrator.** Bootstrap submission (2), the peer worker read, and the
  legacy pinned migration (2, startup only).
- **`provider/Layers/OpencodeV2/ThreadToolsSetup.location.ts`.** It ensures, then re-reads. The
  touch guarantee covers it. It was left unedited because that area is being changed in parallel.

## Eviction rule and bound

The constants are in `Layers/OrchestrationEngine.residency.ts`:

| Constant                                | Value  | Meaning                                                                                    |
| --------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| `READ_MODEL_MAX_RESIDENT_THREADS`       | 500    | Above this, least-recently-used idle threads are candidates until back at the bound        |
| `READ_MODEL_THREAD_IDLE_TTL_MS`         | 10 min | An idle thread untouched this long is a candidate whatever the count                       |
| `READ_MODEL_MIN_RESIDENCY_MS`           | 60 s   | A thread touched more recently than this is never a candidate                              |
| `READ_MODEL_EVICTION_BATCH`             | 200    | At most this many candidates checked per sweep (bounds the time under the command barrier) |
| `READ_MODEL_EVICTION_SWEEP_INTERVAL_MS` | 60 s   | Sweep period (`ReadModelResidencySweeper`, started with the other reactors)                |

A candidate is evicted only if every one of these holds:

1. **In memory it carries no resumable work** (`isThreadResidentWorkIdle`). There is:
   - no session, or a `stopped` one (so `ready`, `starting`, `running`, `interrupted` and
     `error` are all kept);
   - no active turn and no running latest turn;
   - no pending turn start, queued prompt, turn-control operation, interrupt flush or recovery
     notice;
   - no active task, no watch, no pin, and no deletion in progress.
2. **No resident thread names it as parent.** Ancestor chains used by the deletion fence and the
   deletion-root logic stay whole; leaves go first.
3. **No deletion fence covers it** (`threadDeletion.isFenced`).
4. **No outside hold.** It has no live provider session in this process
   (`ProviderService.listSessions`) and no active terminal (`TerminalManager.hasActiveThread`).
5. **The per-thread SQL check is false** (`ProjectionOperationalStateQuery.isThreadOperational`).
   This is the startup predicate (now one exported fragment, `operationalThreadPredicateSql`)
   filtered by id, plus any `worktree_runtime_leases`, `thread_activity_leases` or non-terminal
   `provider_turn_admissions` row. A failed SQL check evicts nothing in that sweep.

Eviction removes the thread, its `historyLoaded` flag and its residency entry, under the command
semaphore.

**Rehydration.** The next by-id access, command, or provider event loads the thread again from
durable projections plus the retained events after them. For provider events, ingestion already
hydrates at `history` level before it reads or dispatches. Nothing is dropped.

**Interest.** WebSocket subscribers read thread detail from SQL projections (`ProjectionCatalogQuery`)
and domain events from the event stream, so no subscriber depends on residency.

**Projects** are not evicted. Their count is bounded by the number of projects. See "Left".

## Tests

New:

- `Layers/OrchestrationEngine.residency.test.ts` (4): the in-memory guard for every busy state;
  the TTL in LRU order; trimming to the bound past the minimum residency; parent protection and
  the batch cap.
- `Layers/OrchestrationEngine.eviction.test.ts` (4, real engine over SQLite, driven clock):
  - **Bounded memory:** 50 threads drop to 10, and drop to 10 again after a project-wide
    rehydrate.
  - **Rehydration:** an evicted thread comes back intact through the accessor and the command
    path (rename), and project-wide reads see every thread.
  - **Subtree:** an evicted child is hydrated for subtree deletion, and the root is kept while
    its child is resident.
  - **Never while live:** a `ready` session, an outside hold, a pin, and a thread kept only by
    the SQL lease check are all kept; only the idle one goes.
  - **Restart and mixed workload:** after a restart, 30 settled threads are renamed with 6-way
    concurrency while sweeps interleave. Every rename lands, and residency stays bounded.
- `Layers/ProviderRuntimeIngestion.eviction.test.ts` (1): the thread's session is stopped and
  the thread is evicted. A late `request.opened` then reaches the real ingestion pipeline. The
  thread is rehydrated, and the approval activity is applied in memory and persisted.
- `Layers/ReadModelResidencySweeper.test.ts` (2): live provider sessions and active terminals
  hold a thread. Without eviction support the sweeper is inert.

Adapted: the steer handler test (the `resolveThread` dependency was removed), and the browser and
agent workspace tests (the engine is passed instead of `readModel`). The shared harnesses
`OrchestrationEngine.test.runtime.ts` and `ProviderRuntimeIngestion.test.helpers.ts` take an
optional residency config. The shared app test host (`server.test.app.ts`) gives its mocked
engine a `getThread` derived from the test's `getReadModel`, because `Layer.mock` turns unmocked
members into dying stubs.

**Mutation checks** (each restored afterwards):

| Mutation                                                     | Caught by                         |
| ------------------------------------------------------------ | --------------------------------- |
| Ingestion reads the read model directly instead of hydrating | The late-event test fails         |
| Eviction skips the SQL operational check                     | The "never while live" test fails |
| Subtree hydration loads only the root                        | The subtree test fails            |

## Checks

- `bun run --cwd apps/server typecheck`: clean.
- Explicit-path `bunx oxfmt` and `bunx oxlint` on the 59 changed files: clean. The one lint
  warning is pre-existing (`ThreadOrchestrationTools.listAvailableModels.ts:72`).
- Every changed file is 400 lines or fewer. `ProviderRuntimeIngestion.processor.runtime.ts` is
  exactly 400 (it was 399).
- Focused Vitest on the neighbouring suites, as explicit file lists: 421 files and 2,092 tests pass (2
  skipped). The first run found 2 test-double failures, fixed as described under "Tests":
  - the orchestration engine, ingestion, provider command, checkpoint, learning, prompt
    suggestion, watch, scheduler and supervisor reactors, operational query and metadata
    generation (`orchestration/Layers`);
  - `orchestration-tools`;
  - the WebSocket bootstrap, shell dispatch, RPC handlers, HTTP thread tools and streams;
  - retention, deletion, computer-use stop, peer orchestration and project.

## Left

- **Projects are never evicted.** A project is small, and the count is bounded by the user's
  projects. Evicting them would need the same treatment for `projects` reads (about 10 sites).
- **Hydration does not load ancestors.** A thread hydrated by id does not pull in its parents,
  so `isThreadFenced` and `resolveProjectDeletionRoots` can miss a non-resident ancestor. This
  was already true after a restart. Eviction does not make it worse: it never breaks a chain
  that is resident.
- **Startup predicate precedence (pre-existing, not changed).** `listOperationalProjectRows` and
  the startup message and activity window queries use `AND ${operationalThreadPredicate}` without
  parentheses. Its top-level `OR` terms escape the project or thread match, so the startup window
  loads more projects (and window rows) than intended. Behaviour is over-inclusive, not lossy.
  The new per-thread check wraps the predicate in parentheses.
- **Deleted threads.** A by-id hydration of a deleted thread installs it with `deletedAt` set (an
  existing hydrator behaviour). Such a thread is idle and is evicted by the next sweep.
- **`ensureThreadState` still waits for the barrier.** Its existing callers keep that
  semantics. Only the new `getThread` reads resident threads lock-free.
