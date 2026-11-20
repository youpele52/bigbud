# D-1 root cause (the backend wedge under concurrent sessions) and live re-run of D-2 and D-3

**Date:** 19 November 2026, 07:15–09:40 UTC
**Source under test:** `git archive` of `dev` HEAD `e4cb6269ef` (tree `30034e3103…`). The working
tree was not used for any build. It includes the D-3 fix `d5232c7879` and the D-2 fix `cfea37bc6c`.
**Related:** [unit-only fixes live re-run](2026-11-18-unit-only-fixes-live-rerun.md) (D-1, D-2 and
D-3 were found there), [read-model eviction](2026-11-18-read-model-eviction.md) (F-B4, reverted in
`1dada47038`).

**Verdict:**

- **D-1 is found and fixed. It was not caused by eviction.** It is a lock-order inversion between
  the provider session directory's in-memory write lock and the single SQLite connection. It has
  been in the code since `07356fbac1` (25 October 2026). Eviction made it far more likely to
  happen; it did not create it. The D-2 fix does not change it. A deterministic regression test
  reproduces the deadlock on the old code. With the fix, the eviction build completes 1/4/8
  sessions live, and eviction still bounds the read model.
- **D-3: PASS.** Every per-thread delete, including deletes issued 2 s after
  `thread.session.stop`, completed in about 1 s. No retention run was deferred.
- **D-2: PASS for the stall.** Cascade cleanup ran in about 1 s, with no 15-minute cooldown. No
  scratch baseline row reached the live `projection_baseline_rows`.
- **New defect D-4: FAIL.** After the D-2 fix, a project delete can abort with "Timed out waiting
  for threads … to delete" although its threads were deleted. This happened in 2 of 2 cascade runs that reached the project delete, on graph A and graph F.

| #   | Case                                                                           | Result                                                                   |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 1a  | Project cascade: cleanup is prompt, no scratch rows in the live database (D-2) | **PASS** for D-2; the project delete itself aborted (**D-4**, new)       |
| 1b  | Retention delete issued about 2 s after `thread.session.stop` (D-3), 3 runs    | **PASS** (3/3 completed in about 4 s, none deferred)                     |
| 1b' | Direct `thread.delete` 2 s after `thread.session.stop` (D-3), 5 in a row       | **PASS** (5/5 deleted in about 1 s)                                      |
| 2   | D-1 reproduced on current dev with eviction re-applied, lock holder captured   | **Reproduced** in 2 of 2 runs; holder and cycle named                    |
| 2'  | Same measurement on current dev without eviction                               | **Wedged in 2 of 4** runs with concurrent sessions (`bba2`, `bbc2`)      |
| 3   | Eviction re-applied plus the D-1 fix: 1/4/8 sessions                           | **PASS**: 4 of 4 completed, plus 1 cascade setup; no diagnostic warnings |
| 3'  | Eviction still bounds the read model                                           | **PASS**: 561 → 500 resident while 4/8 sessions ran; rehydration works   |

## Environment

- **Host:** macOS, Lima 2.3.0. Builds and the musl agent ran in a disposable
  `node:24.13.1-bookworm --rm` container (rustup 1.95.0).
- **VM** `bb-d1-a`: vz, Ubuntu 22.04 arm64 `release-20261020`, **2 CPUs, 4 GiB**, 14 GiB disk,
  `mounts: []`, every port forward ignored, Lima `user-v2` network. This is the shape of the
  earlier measurement VM. One fresh account per case, set up with `backend setup …
--confirm-fresh-setup` and `backend start`, with the validator fake Codex.
- **Builds.** All are signed with a throwaway Ed25519 fixture key `dev-fixture-d1`. The private
  key was deleted and never archived.

| Graph                   | Content                                                                                       | Archive sha256  | buildDigest      |
| ----------------------- | --------------------------------------------------------------------------------------------- | --------------- | ---------------- |
| **A** `0.1.613-dev.d1a` | HEAD `e4cb6269ef`, unmodified                                                                 | `7931c43f…0386` | `7f116d5c…fe98f` |
| **E** `0.1.613-dev.d1e` | A + eviction re-applied (the code hunks of `1dada47038` reversed) + F-1 + diagnostics (below) | `fc58d55e…61dc` | `ae5f0fe2…98fa9` |
| **F** `0.1.613-dev.d1f` | E + the D-1 fix                                                                               | `71dbcfd9…185b` | `d665723c…1708`  |

- **Agent** `0.3.3-d1.e4cb6269efd8`, protocol 1.8, sha256 `d8ab2e3e…7620c`.
- **Diagnostics in E and F only** (`logs/graph-f-diagnostics-vs-worktree.diff`). A new scratch
  module `D1Diag.ts` records, with each fiber's Effect span chain:
  - the holder and waiters of each SQLite connection's transaction permit and of the command
    barrier;
  - the transaction state of each connection (BEGIN, COMMIT, ROLLBACK, a SAVEPOINT that would
    open a transaction, and the last statement);
  - every `getThread` miss made while holding a SQL transaction or the barrier.

  A watchdog logs any holder or open transaction older than 8 s, and `SIGUSR2` dumps all of them.
  The eviction sweep also logs `{evicted, resident}` on every run. None of this is in the
  working tree.

- **Measurement:** `apps/server/scripts/remoteBackendMeasure*.ts` from HEAD, with the earlier
  flags: `--levels 1,4,8 --history-turns 10 --measured-turns 3 --idle-ms 10000
--latency-samples 7 --fake-provider --restart-for-readiness`.

## 1. D-2 and D-3 on current dev (graph A)

### 1a. Project cascade (D-2): the stall is gone; the project delete aborted (D-4, new)

`deldrv.mjs cascade` on `bbc1` (`live/10`). The driver creates a project with threads A, B and
child C (parent B), and runs one fake turn on each thread concurrently. It stops the sessions and
writes a provider log per thread. Then it deletes A, deletes the project, and waits for the logs
and the canonical events to go. Before the run, a trigger was added to the live database that
records every insert of a scratch baseline row (`baseline_id = 0`) into `projection_baseline_rows`
(`tools/vm/scratchaudit`).

| Step                             | Result                                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Thread A delete                  | gone after 1.0 s; provider log removed after 1.0 s                                                                                            |
| Project delete cascading B and C | B and C gone after 1.0 s; both provider logs removed at once                                                                                  |
| Baseline verification            | 2 verifications, 0.96 s and 0.73 s, both on workspace databases                                                                               |
| Compaction stall messages        | **0** (`did not reach requested sequence`, `baseline coverage deferred`)                                                                      |
| Live scratch rows                | **0** inserts audited, 0 rows present                                                                                                         |
| Cleanup plans                    | `completed=2`; verified baseline at sequence 54                                                                                               |
| Project itself                   | **not deleted.** `project deletion aborted: Timed out waiting for threads in project … to delete` after exactly 30 s; 3 project events stayed |

So the D-2 fix works live: no cooldown, cleanup in about 1 s, and verification no longer writes
to the live database. The run still fails as a case because of D-4.

**D-4 (new, not fixed).** The project-delete handler waits for the project's threads to be
deleted (`waitForProjectThreadsToSettle`, 30 s). It checks the read model once, then re-checks on
each later domain event (`waitForReadModelCondition`).

- The cascade's `thread.deleted` (sequence 54) committed within about 50 ms of the waiter's first
  check (trace: `processDeletionRequested` for B ran from 22.856 to 23.700 s, and the waiter
  started at 22.868 s).
- After that there was never another event, so the waiter timed out and aborted the delete.
- The in-memory read model was clean afterwards: re-issuing `project.delete` at 07:40 emitted no
  thread deletion request and completed at once (`live/vm/accounts/bbc1`).
- So the waiter missed the cascade's completion. Two ways fit the evidence:
  - a lost wake-up between the first check and the stream subscription (the stream starts at
    the read model's current sequence and wakes only on later publishes);
  - the replay read happening after the thread's canonical events were pruned (finalize prunes
    them immediately, now that D-2 no longer stalls pruning, and per-thread pruning does not
    respect open reactor cursors), so the page is empty and nothing re-checks.
- It did not show in the previous run, where D-2 kept every event for 15 minutes. It does show
  with eviction: graph F (`bbx1`) aborted identically.
- It reproduced in 2 of 2 cascade runs that reached the project delete (`bbc1` on graph A,
  `bbx1` on graph F; `live/10`, `live/70`). Each time, the cascaded threads and their logs were
  gone in 1 s, the project delete aborted after exactly 30 s, and 3 project events were left. A
  third run (`bbc2`, graph A) never got that far: it hit D-1 during its 3 concurrent turns.
- Re-issuing the project delete succeeds. The user-visible effect is that the first delete of a
  project fails.
- **Suggested fix:** make the waiter subscribe before its first check, and re-check on a short
  timer as well as on events, so a missed or pruned event cannot strand it. This was not
  changed here.

### 1b. Retention and direct deletes after `thread.session.stop` (D-3): PASS

`bbr1` (`live/20`, `live/21`):

- **Direct deletes:** five threads in a row. Each ran one fake turn, then `thread.session.stop`,
  and `thread.delete` exactly 2.00 s later. All five were gone in 1.015–1.035 s, and each
  provider log was removed at once.
- **Retention:** three runs. Each created an "old" thread (`createdAt` 10 days ago) with one fake
  turn, stopped its session, and 2 s later previewed and started a manual 1-day `created`
  retention run.
  - Every run ended **`completed` in 4.0 s**: `eligibleCount 1`, `completedCount 1`,
    `uncertainCount 0`, `canonicalPendingCount 0`. None was deferred.
  - The old thread was deleted, its provider log removed, and its canonical events pruned. The
    new thread and its log were kept.
- **End state:** 8 cleanup plans, all `completed`, and a verified baseline at sequence 159. The
  account logged no stall messages, and no scratch rows were inserted.

## 2. D-1: root cause

### Reproduction with the lock holder named (graph E)

The 1/4/8 measurement ran on a fresh account each time.

| Run    | Graph           | Result                                                                                                                                                                                                |
| ------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bbm1` | E (eviction)    | level 1 done; **wedged at level 4** (07:41:15). External `BEGIN IMMEDIATE`: `database is locked`. Stop took 15.3 s, `Result=timeout`, SIGKILL                                                         |
| `bbm2` | E (eviction)    | level 1 done; **wedged at level 4** (07:57:48), same holder                                                                                                                                           |
| `bba1` | A (no eviction) | 1/4/8 completed                                                                                                                                                                                       |
| `bba2` | A (no eviction) | levels 1 and 4 done; **wedged at level 8** (09:13). Directory listing timed out every 5 s until the account was removed 9 minutes later. External `BEGIN IMMEDIATE` at 09:17:56: `database is locked` |
| `bbc2` | A (no eviction) | **wedged** during the cascade setup (3 concurrent fake turns): `dispatchCommand` deadline 120 s, `database is locked`, directory listing timeouts                                                     |
| `bbc1` | A (no eviction) | cascade setup (3 concurrent turns) completed                                                                                                                                                          |

The diagnostics named the holder in both E runs (`live/vm/bbm1-d1diag-holders.log`, and
`accounts/bbm*/d1diag.log`):

- **Holder:** the `state.sqlite` transaction permit has been held since the wedge by fiber
  `recordAcceptedSendTurn ← sendTurn ← sendTurnAttempt ← sendTurnForThread ←
processTurnStartRequested`. Its transaction is open, and its last statement is `INSERT INTO
provider_turn_liveness`.
- **Command barrier:** not held.
- **Waiters:** every reactor, the RPC reads, and one fiber `ProviderSessionRuntimeRepository.upsert
← startSession ← ensureSessionForThread ← sendTurnAttempt ← processTurnStartRequested`, for
  another thread.
- **Not seen:** no `getThread` miss under a transaction or the barrier, no barrier self-wait, no
  SAVEPOINT outside a transaction, and no BEGIN inside an open transaction.

### The cycle

`ProviderService.sendTurn` records an accepted turn with `recordAcceptedSendTurn`. When there is
a dispatch attempt, it calls `ProviderDispatchAttemptRepository.acknowledgeWith(attempt,
writes)`. That runs inside one `sql.withTransaction`:

1. `writes`: `ProviderTurnLiveness.startTurn` (the `INSERT INTO provider_turn_liveness` seen
   above), then `ProviderSessionDirectory.upsert(binding)`;
2. then the attempt `UPDATE … SET state = 'provider-acknowledged'`.

`ProviderSessionDirectory.upsert` is `writes.withPermits(1)(read, merge, write)`. Its `writes`
semaphore is one global lock for all threads.

| Fiber                                                        | Holds                                                    | Waits for                                           |
| ------------------------------------------------------------ | -------------------------------------------------------- | --------------------------------------------------- |
| X: thread T1 turn start, `acknowledgeWith`                   | the SQL transaction (the only write connection's permit) | the directory `writes` lock                         |
| Y: thread T2 turn start, `startSession` → `directory.upsert` | the directory `writes` lock                              | the SQL connection (its `getByThreadId` / `upsert`) |

Neither can proceed. Every other statement queues behind X's permit, so every command, query and
RPC times out. The open write transaction makes another connection's `BEGIN IMMEDIATE` fail. The
SQL fiber cannot be interrupted out of the wait at shutdown (the permit is held in an
uninterruptible region), so `systemctl stop` ends in SIGKILL. This matches every D-1 observation
from the previous report, including "thread A's turn completed in the fake but its events were
never committed".

**This is not eviction's bug.** The in-transaction directory write has existed since
`07356fbac1` (25 October 2026). It is in the parent `9c142552ee`, which passed its one run, and
in current dev, which wedged in 2 of 4 runs with concurrent sessions here. Graph A has no
diagnostics, so its holder was not named live. Its symptoms are identical. The regression test below
deadlocks on current dev's code with eviction absent.

**Why eviction made it so much likelier.** With eviction, the checkpoint reactor reads each
thread at `history` level on `turn.started` and on the turn-start event. For a thread whose
history is not loaded, that hydrates under the command barrier with a SQL transaction. That
staggers the per-thread turn starts, so one thread's session start (Y) lands inside another
thread's acknowledgement (X) far more often. This explanation is inferred from the spans, not
proven. The measured rate is 2 of 2 wedges with eviction, 2 of 4 without it, and 0 of 5 with the fix
(4 measurements and 1 cascade setup).

**D-2 lead: ruled out as the mechanism.**

- D-1 still happens with the D-2 fix (graph E).
- No baseline or verification span is among the holder, its waiters, or the open transaction.
- Verification now runs on its own connection.

The D-2 bug did run live repositories inside workspace transactions, because
`TransactionConnection` is a single global key, not one per client. But no live in-memory lock
was taken inside those transactions.

## 3. Fix and re-land

**Fix: one lock order, the directory write lock first, then SQL.**

- `ProviderSessionDirectoryShape` gains an optional `withWriteLock(use)`. It runs `use` holding
  the write lock and passes it an `upsert` that does not take the lock again. The interface
  comment states the lock order and why.
- `recordAcceptedSendTurn` now takes the write lock **before** the acknowledgement transaction
  opens, and writes the binding with the lock-free `upsert` inside it. Without `withWriteLock`
  (test doubles) it keeps the plain `upsert`.
- Nothing else writes a binding inside a SQL transaction. `remove` and `setCodexRewind` take the
  lock outside any transaction, as before.

Why not a SQL transaction for every directory write instead: `ProviderSessionRuntime.upsert`
captures a filesystem lease identity before its own transaction, and a directory-wide transaction
would move that I/O under the only connection.

**Re-land in the working tree (not committed):**

- **Eviction:** the code hunks of `git diff 1dada47038 1dada47038^ -- apps/`.
  `git revert --no-commit 1dada47038` does not apply cleanly (its docs hunks conflict with
  `2026-11-18-remote-mobile-completion-status.md`), so only the code was applied. It applied
  cleanly: 55 files, the same as `e84335fe60`.
- **F-1:** one sweep per interval, and its test (from the previous run's archived diff).
- **The D-1 fix:** `ProviderSessionDirectory.ts` (service and layer) and
  `ProviderService.sendTurn.record.ts`.
- **New test:** `ProviderService.sendTurn.record.lockOrder.test.ts`. It uses the real directory,
  dispatch-attempt and session-runtime repositories over in-memory SQLite, and forces the live
  interleaving:
  - the acknowledgement transaction opens;
  - another thread's binding write starts, and the test waits until that write has taken the
    write lock and reached its SQL read, or 300 ms if it cannot;
  - then the acknowledgement writes its binding.

  It passes in 0.8 s. **Mutation:** with `ProviderService.sendTurn.record.ts` restored from HEAD,
  it fails after 10 s with "acknowledgement deadlocked on the write lock".

- The eviction report's banner is updated.

### Live confirmation (graph F = the working tree's code plus diagnostics)

| Run    | Result                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------ |
| `bbf1` | 1/4/8 completed; 0 diagnostic warnings (no transaction or lock held over 8 s)                                            |
| `bbf2` | 1/4/8 completed; 0 diagnostic warnings                                                                                   |
| `bbf3` | 1/4/8 completed; 0 diagnostic warnings                                                                                   |
| `bbf4` | 1/4/8 completed with 560 extra threads and the eviction sweep running during the run (no restart); 0 diagnostic warnings |
| `bbx1` | cascade setup with 3 concurrent turns completed (then D-4, above)                                                        |

Turn latency median (ms), and peak RSS runtime-only / inclusive (MiB). The VM has 2 CPUs and is
saturated from 4 sessions.

| Run                     | 1 session      | 4 sessions       | 8 sessions         | Idle RSS (MiB) |
| ----------------------- | -------------- | ---------------- | ------------------ | -------------- |
| `bba1` (A, no eviction) | 792; 406 / 481 | 1,896; 417 / 794 | 3,424; 427 / 1,202 | 292            |
| `bbf1` (F)              | 802; 407 / 483 | 1,903; 402 / 899 | 3,464; 443 / 1,156 | 230            |
| `bbf2` (F)              | 805; 393 / 466 | 1,860; 408 / 782 | 3,510; 420 / 1,147 | 293            |
| `bbf3` (F)              | 813; 385 / 461 | 2,435; 413 / 791 | 4,510; 439 / 1,193 | 290            |
| `bbf4` (F, 560 threads) | 815; 396 / 473 | 2,409; 426 / 801 | 4,787; 447 / 1,124 | 413            |

With the fix, the eviction build performs like current dev without eviction. The slower `bbf3`
and `bbf4` runs ran right after other accounts on the same 2-CPU VM. `bbf4` also held 560
threads and ran eviction sweeps during the run.

### Eviction still bounds the read model (`bbf4`, `live/60`–`62`)

- **Bound:** 560 threads were created (12.7 s). The 1/4/8 measurement then ran on the same
  backend without a restart. The sweep logged `resident: 561` at 09:29:10. At 09:30:10, inside
  the 4- and 8-session levels, it logged `evicted: 68, resident: 500`.
- **Rehydration:**
  - `thread.meta.update` on the oldest bulk thread succeeded in 34 ms, and the projection shows
    the new title.
  - A fake turn on the second-oldest thread produced its assistant message.
- **No wedge:** the account logged no diagnostic warnings, and the measurement completed.
- **Not covered here:** the 10-minute TTL was not waited for; the 18 November run covered it.

## Checks

- **Length:** every changed file has 400 lines or fewer. The largest is
  `ProviderRuntimeIngestion.processor.runtime.ts` at exactly 400, as in `e84335fe60`.
- **Format and lint:** explicit-path `bunx oxfmt --check` and `bunx oxlint` on all 64 changed and
  new files: clean. The one lint warning is pre-existing
  (`ThreadOrchestrationTools.listAvailableModels.ts:74`, noted in the eviction report).
- **Types:** `bun run --cwd apps/server typecheck`: exit 0, 0 errors.
- **Focused Vitest:** 37 files and 164 tests pass. They cover:
  - the new lock-order test;
  - `ProviderService.sendTurn*`, `ProviderSessionDirectory*`, `ProviderDispatchAttempts` and
    `ProviderTurnLiveness`;
  - the eviction, residency, ingestion-eviction and sweeper tests;
  - the steer, browser and agent-workspace tests;
  - deletion: canonical, cascade resources and retention delete;
  - session recovery, startup and stop, and the turn-start backstop;
  - `wsBootstrap`, `wsShellDispatch`, remote workspace and computer-use tools;
  - direct retention.
- **Shared app test host consumers:** 3 of 4 files pass. `clientRelay.leases.test.ts` fails 3
  tests, identically on the unmodified HEAD snapshot. It is environmental and unrelated.
- **Not run (approval needed):** no repository-wide checks. Nothing was committed or pushed.

## Remaining risks

- **D-4 (new):** project deletes can abort after a cascade (above). It is not fixed here.
- **The same class of bug elsewhere.** Any in-memory lock whose holders run SQL, taken inside a
  SQL transaction, can wedge the single connection in the same way. Only this site was found by
  the diagnostics and by a search of directory writes. A permanent, cheap watchdog for SQL
  transactions held longer than N seconds would turn the next one into a logged span chain
  instead of a silent wedge.
- **Holding the lock longer.** The acknowledgement now holds the directory write lock while it
  waits for the SQL permit. Other directory writes wait a little longer under load. There is no
  deadlock, because every holder of the lock waits only for SQL, and no SQL holder waits for the
  lock.
- **Eviction's history reads.** The checkpoint reactor's first `history` read of a thread takes
  the command barrier and runs a SQL transaction. That is correct, but it is extra work on the
  first turn of every thread whose history is not loaded.

## Invalid attempts (voided, not counted)

- **`bbf2`, `bbf3`, `bbf4`, `bba2` (series 1):** never created. `useradd` ran out of
  subordinate UID ranges, because the Lima user owns most of the space. Finished accounts were
  then archived and deleted.
- **`bbf2`, `bba2`, `bbf3` (series 2):** a `handshake deadline` after 3 s. They reused the UIDs
  of deleted accounts whose `user@UID` units had stayed failed. The units are now reset in
  `provision-user.sh` and `measure-run`.
- **`bba3`, `bbc3`:** setup did not complete, for the same reason.

## Evidence

- **Archive:** `~/DevWorld/bigbud-evidence/tmp-bigbud-evidence-20261119-d1-d2-d3.tar.zst`, with a
  `.sha256` file. It holds the run directory `/Users/youpele/.claude/jobs/8ac2e1cd/tmp/d1/`,
  without the source snapshots, builds, the staging area or the keys.
- **Contents:**
  - `live/`: one log per step, with the command at the top.
  - `live/vm/accounts/<user>/`: journal, `d1diag.log`, server trace, measurement JSON and
    markdown, `delsnap`.
  - `live/vm/bbm1-d1diag-holders.log`: the SIGUSR2 dump of the wedge.
  - `logs/`: builds, hashes, `eviction-reapply.diff`, `f1.diff`, `d1-fix.diff`, the
    diagnostics diff, typecheck and Vitest logs.
  - `tools/`: the VM YAML and the harness scripts (`deldrv.mjs` gained `stopdelete`; new
    `measure-run`, `collect` and `scratchaudit`).
- **Not archived:** source snapshots, builds and the fixture private key.
