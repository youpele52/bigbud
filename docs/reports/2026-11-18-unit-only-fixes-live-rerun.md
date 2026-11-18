# Live re-run of fixes that had only unit evidence (Lima, aarch64)

**Date:** 18 November 2026, 16:00–17:55 UTC
**Source under test:** `git archive` of `dev` HEAD `e84335fe60` (tree `9045606c…`). The working
tree was not used. Every commit under test is an ancestor of that HEAD: `d8beeded52`,
`51ce573251`, `e84335fe60`, `cc85ccbbfc`, `f49e521f6e` and `79a55b6136`.
**Related:** [M1 live systemd](2026-11-17-m1-live-systemd-acceptance.md),
[P8 live](2026-11-18-p8-live-acceptance.md),
[mobile increment 7](2026-11-18-mobile-increment-7-live-acceptance.md),
[arm64 deletion](2026-11-18-linux-arm64-deletion-fix.md),
[measurements](2026-11-18-remote-backend-measurements.md),
[compaction stall fix](2026-11-18-canonical-compaction-stall-fix.md),
[O-2/O-6](2026-11-18-o2-o6-shutdown-and-chats-bootstrap.md),
[read-model eviction](2026-11-18-read-model-eviction.md),
[mobile stage retirement](2026-11-18-mobile-stage-retirement.md),
[peer refusal](2026-11-18-peer-rejection-and-setup-permissions.md),
[O-1 installation id](2026-11-18-o1-installation-identity-fallback.md).

**Verdict:** O-2/O-6, mobile stage retirement, the late peer refusal, O-1 and the three P8 gaps
pass live. F-B4 eviction behaves as designed, after one small fix made here (the sweep ran every
120 s, not every 60 s). Three defects were found live and are **not fixed**:

- **D-1 (blocking): the backend can wedge on SQLite under concurrent provider sessions.** One
  write transaction is never committed. From then on every command, query and RPC times out,
  `systemctl --user stop` needs `SIGKILL`, and only a restart recovers. It happened in 3 HEAD
  runs with concurrent fake-Codex sessions (3 concurrent turns once, and both 1/4/8 measurement
  runs, at the 4- and 8-session levels). It did not happen in the one run of the same
  measurement on `e84335fe60`'s parent. F-B4 (`e84335fe60`) is the likely cause; the
  exact lock cycle was not found. The 1/4/8 measurement therefore cannot be completed on HEAD.
- **D-2: the canonical compaction stall still happens after a project cascade.** An
  intermediate baseline candidate is rejected during the cascade, and the 15-minute failure
  cooldown then defers all cascade and project cleanup. It is no longer permanent: cleanup
  completes when the cooldown ends.
- **D-3: a thread delete issued about 2 s after `thread.session.stop` can stay `deleting`
  forever.** The deletion request is never processed (2 of 7 deletes), and a retention run
  reports it `deferred`.

| #   | Case                                                                           | Result                                                                       |
| --- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 1   | Compaction stall fix and cascade resource cleanup (`d8beeded52`)               | **FAIL** (D-2). Cascade resources are now reclaimed, after a 15-minute stall |
| 1b  | Retention delete (the DEFERRED row in the arm64 report)                        | **FAIL** (D-3)                                                               |
| 2   | O-2 slow stop and O-6 (`51ce573251`)                                           | **PASS**                                                                     |
| 3a  | F-B4 eviction: bound, TTL, rehydration, provider events on a rehydrated thread | **PASS**, after fix F-1                                                      |
| 3b  | arm64 1/4/8-session measurement                                                | **FAIL** on HEAD (D-1); baseline numbers taken on the parent commit          |
| 4   | Mobile stage retirement (`cc85ccbbfc`): 21 consent revisions                   | **PASS**                                                                     |
| 5   | Late peer refusal delivery (`f49e521f6e`)                                      | **PASS**                                                                     |
| 6   | O-1 installation-id fallback (`79a55b6136`) without `/etc/machine-id`          | **PASS**                                                                     |
| 7a  | P8: approval waits on the worker                                               | **PASS** (observation O-A)                                                   |
| 7b  | P8: grant expiry                                                               | **PASS**                                                                     |
| 7c  | P8: `remote-peer.sock` republished after a worker restart                      | **PASS**                                                                     |

## Environment

- **Host:** macOS, Lima 2.3.0, OrbStack.
- **VMs** (Ubuntu 22.04 arm64 `release-20261020`, vz, `mounts: []`, every port forward ignored,
  shared Lima `user-v2` network; YAML in `tools/`):
  - `bb-rr-a` at `192.168.104.7`: 3 CPUs, 4 GiB, 12 GiB. Re-configured to **2 CPUs** (same 4 GiB)
    for the measurement, to match the earlier measurement VM. It held one lingering account per
    case: `bbrr`, `bbev`, `bbpc` (peer coordinator), `bbmob`, `bbx1`–`bbx3`, `bbc1`, `bbc2`, `bbm`,
    `bbm2`, `bbm3`.
  - `bb-rr-w` at `192.168.104.8`: 2 CPUs, 2 GiB, 8 GiB. Accounts `bbpw` (peer worker) and `bbid`
    (O-1 SSH target).
- **O-1 laptop:** a disposable `node:24.13.1-bookworm` container (`--rm`). It has no
  `/etc/machine-id` and no `/var/lib/dbus/machine-id`. It ran graph A's own server in
  `--mode web` and reached `bbid` over SSH through Lima's forwarded port.
- **Builds** (all from the snapshot, signed with a throwaway Ed25519 fixture key
  `dev-fixture-rr`; the private key was never archived):
  - Graph **A** `0.1.613-dev.rr1`: unmodified HEAD. Archive sha256 `a362b2cb…64ead0cd`,
    buildDigest `963b2ef1…fad81bba`. The loader policy accepted it unmodified.
  - Graph **B** `0.1.613-dev.rr1ev`: A plus one observability-only change. The sweeper's
    `logDebug("evicted idle threads…")` becomes a warning logged on every sweep with
    `{evicted, resident}` (`logs/test-graph-b-eviction-log.diff`). There is no log-level seam,
    because the launcher clears the environment.
  - Graphs **C** `0.1.613-dev.rr2fix` and **D** (C plus B's log line): HEAD plus fix F-1 and a
    _diagnostic_ baseline change (`logs/diagnostic-baseline-change-reverted.diff`). The
    diagnostic change was **reverted** in the repo (see D-2).
  - Graph **P** `0.1.613-dev.rrprev`: `git archive 9c142552ee` (the parent of `e84335fe60`), for
    the D-1 bisection.
  - Musl agent `0.3.3-rr.e84335fe60f7`, protocol 1.8, sha256 `871fafd8…f30f1`. Mobile gateway
    `809aa448…99a9e2`. Both were built in a disposable `node:24.13.1-bookworm --rm` container
    with rustup 1.95.0.
  - Mobile assets: `VITE_MOBILE_BASE=/mobile/ vite build`, then `package:mobile-components` with
    validator placeholder notice texts. The artifact URL host is `github.com`, because
    `example.invalid` is refused as an unapproved host (`INVALID-41`).
  - All hashes are in `logs/artifact-hashes.txt`.
- **Deployment:** for every account, `backend setup … --confirm-fresh-setup`, then
  `backend start`. Units were not enabled for boot.
- **Provider:** the P8 validator fake Codex (`tools/drv/fakeCodex.mjs`): `SLOW:`, `APPROVAL` and
  `PEERTOOL:`. No real credentials were used.
- **Clients:** one-shot drivers on the host account, over the private client socket and client
  token (`drv/p8.mjs`, `evdrv.mjs`, `deldrv.mjs`, `hold.mjs`). The O-1 laptop RPC went to the
  laptop's own WebSocket.

## Results

### 1. Compaction stall and project-cascade resources (`d8beeded52`): FAIL (D-2)

**Steps** (`deldrv.mjs cascade`). Each run creates a project with threads A, B and child C
(parent B). It runs one fake turn on each thread concurrently, stops the sessions, and writes a
provider log for each thread (a resource only the Rust executor removes). It then deletes A,
deletes the project (cascading B and C), and waits for the logs and the canonical events to go.

| Run (account, graph)                        | A delete                       | Project delete                                        | B/C logs removed                          | Events pruned                         | Stall messages                              |
| ------------------------------------------- | ------------------------------ | ----------------------------------------------------- | ----------------------------------------- | ------------------------------------- | ------------------------------------------- |
| `bbx2`, A (HEAD), after 4 stop/start cycles | 1.0 s                          | 1.0 s                                                 | after **15 min 3 s**                      | yes (0 rows left), after the cooldown | 179 × `did not reach requested sequence 55` |
| `bbc1`, C (diagnostic)                      | 1.0 s                          | 1.0 s                                                 | after **15 min 4 s**                      | yes, after the cooldown               | 180 × `candidate 54 was rejected`           |
| `bbx1`, A (HEAD)                            | D-3 (A's own delete never ran) | aborted (`Timed out waiting for threads … to delete`) | yes (A, B, C were deleted by the cascade) | threads yes; project 3 events         | 0                                           |
| `bbrr`, A (HEAD)                            | –                              | –                                                     | –                                         | –                                     | wedged by D-1 before any delete             |

**What this shows:**

- The cascade now plans and removes the cascaded threads' provider logs, so the
  `directResources: []` leak is fixed. Plans `completed=3`, the logs are gone, and
  `orchestration_events` is empty for every deleted entity (`live/vm/a/delsnap-final.txt`).
- The stall is still there. On `bbx2` the backend logged
  `ensureBaseline:postcondition … did not reach requested sequence 55` every 5 s from 17:27:49 to
  17:42:46 local. The only verified baseline stayed at 51, while all 11 projectors and the
  frontier were at 55. At 17:42:52, exactly 15 minutes later, the first real retry verified
  baseline 55, and every plan completed.

**Diagnosis of D-2** (`bbc1`, diagnostic graph C):

- A temporary change made a rejected baseline candidate fail the flight with its own message.
- The log then named the trigger: `projection baseline candidate 54 was rejected`.
- The candidate is captured while the cascade is between `thread.deleted` (54) and
  `project.deleted` (55). Verifying that candidate (replay from 51 compared with the live rows)
  does not match.
- The coordinator then holds that failure for `PROJECTION_BASELINE_FAILURE_COOLDOWN_MS`
  (15 min) and replays it to the 5-second recovery loop.
- When the cooldown expires, the first new attempt captures 55 and verifies. So the mismatch is
  specific to the intermediate state, not a lasting replay divergence.
- The likely cause is a non-event mutation of live projection rows that races the capture. For
  example, purging thread A's projection rows after baseline 51 covered A, while the replay
  source still holds them. This was not confirmed.
- Two minimal ideas were tried locally:
  - Do not cool down on a postcondition miss.
  - Treat a rejection as a failure.

  Neither removes the stall, because the trigger is a rejection, and rejections must keep the
  cooldown (otherwise a genuine mismatch re-verifies every 5 s). Both changes were reverted;
  their diff is archived. **A real fix needs the capture/verification to be consistent with
  purges** (or a short first retry before the long cooldown). That is a design decision, left to
  the owner.

### 1b. Retention delete: FAIL (D-3)

`deldrv.mjs retention` on `bbc2`:

- **Setup:** an "old" thread (`createdAt` 10 days ago) with one fake turn and its session
  stopped, plus a new thread.
- **Preview:** 1-day policy, `created` criterion. `eligibleCount: 1`. The run was then started.
- **Result:** the run ended `deferred` after its 120 s settle, with `uncertainCount: 1` and
  `completedCount: 0`. The new thread was kept (PASS).
- **The old thread** stayed `deleting` (`deleting_at` set) with **no further event for 12
  minutes**, and its provider log stayed. There was no `processDeletionRequested` span, no
  cleanup plan and no abort. The provider session was `stopped`, and there were no
  lease or admission rows.
- **Same symptom on HEAD:** the same thing happened to `bbx1`'s direct `thread.delete` of A,
  issued about 3 s after `thread.session.stop`. That thread was only removed later, by the
  project cascade.
- In 5 other deletes with the same timing, the request ran within about 1 s. So this is a race,
  where the per-thread reactor never processes `thread.deletion-requested`.
- Not diagnosed further. Graph C differs from HEAD only in the reverted baseline diagnostics and
  in F-1, and `bbx1` (HEAD) shows the same thing.

### 2. O-2 slow stop and O-6 (`51ce573251`): PASS

`stoptime` holds N WebSocket clients on the owner socket (each subscribed to domain events), then
times `systemctl --user stop` of the backend unit (`live/20`, repeated on `bbx2` in `live/14`).

| Clients | Stop (ms)      | Unit result       | Clients closed          |
| ------- | -------------- | ----------------- | ----------------------- |
| 0       | 57, 127        | `success`, exit 0 | –                       |
| 1       | 79, 72, 92, 85 | `success`, exit 0 | at the stop (code 1006) |
| 3       | 82, 88         | `success`, exit 0 | all 3 at the stop       |

- No stop reached `TimeoutStopSec`, and none was killed.
- After each stop, `bigbud backend start` returned both units to Active.
- **O-6:** after 5 and 6 backend starts, `bbrr` and `bbx2` each have **0** `project.created
__chats__` events and 1 projected Chats row.
- **Side observation:** with D-1 wedged, the same stop took 15.3 s and ended `Result=timeout`
  with `SIGKILL`. The client socket was still closed promptly; the wedged SQL fiber held the
  shutdown (`live/15`). After that the backend unit is `NeedsRepair`, `backend start` refuses,
  and `reset-failed` plus `backend start` recovers it (`live/16`).

### 3a. F-B4 read-model eviction (`e84335fe60`): PASS, with fix F-1

There is no config or environment seam for the TTL or the interval, so real time was used
(10-minute TTL). Graph B logs `{evicted, resident}` on every sweep (`live/30`–`33`):

- **Bound:** 600 threads were created on `bbev`, plus 2 threads with fake turns (`hold1` kept a
  live session; `late1` had its session stopped). The first sweep after the 60 s minimum
  residency evicted 102 threads, leaving **500 resident**.
- **TTL:** after 10 idle minutes, sweeps evicted 200, 200 and then 98 (the batch cap), leaving
  **2 resident**. RSS fell from 412 MiB (peak) to 257–262 MiB.
- **Rehydration:**
  - A `thread.meta.update` on an evicted thread succeeded in 340 ms, and the projection shows
    the new title.
  - A new turn on another evicted thread produced the full provider event stream (messages,
    session-set, activity, `turn-settled`) and its messages.
  - Resident went 2 → 4. The renamed thread was evicted again 10 minutes later; the thread with
    a live session stayed.
- **Late events:** a provider event for a thread that is already evicted could not be produced
  live. The fake provider is gone once the session stops, so a late event cannot arrive. The
  turn on a rehydrated thread is the live evidence; the late-event path stays test-only
  (`ProviderRuntimeIngestion.eviction.test.ts`).
- **F-1 (fixed): the sweep ran every 120 s, not 60 s.**
  - Graph B's sweeps were at :09:46, :11:46, :13:46 and so on.
  - The cause: `Effect.repeat(Schedule.spaced(interval))` was applied to `sleep(interval) +
sweep`, which sleeps twice per round.
  - The fix (`ReadModelResidencySweeper.ts`): `Effect.forever(Effect.sleep(interval) + sweep)`.
  - On graph D (`bbx3`, 520 threads) the sweeps ran at :54:58, :55:58, :56:58 and so on: one per
    minute, trimmed to 500, then TTL batches of 200.

### 3b. arm64 measurement: FAIL on HEAD (D-1)

The measurement tool is `apps/server/scripts/remoteBackendMeasure*.ts`, unchanged from HEAD. It
used the same flags as the earlier report (`--levels 1,4,8 --history-turns 10 --measured-turns 3
--idle-ms 10000 --latency-samples 7 --fake-provider --restart-for-readiness`), on a fresh account
on `bb-rr-a` re-configured to 2 CPUs and 4 GiB.

- **HEAD, run 1 (`bbm`, graph A):** level 1 completed. At level 4 the backend wedged (17:13:27
  UTC). `BEGIN IMMEDIATE` from another connection got `database is locked`. Every RPC timed out,
  and the tool aborted with `RPC deadline orchestration.getProjectThreadSummaries`
  (`live/91`).
- **HEAD, run 2 (`bbm3`, graph A):** levels 1 and 4 completed (55 turns settled). At level 8 the
  backend wedged in the same way (17:33:46 UTC, `database is locked`), and the tool was stopped.
- **Parent `9c142552ee` (`bbm2`, graph P, everything except F-B4):** completed 1/4/8 with no
  wedge (`results/parent-9c142552ee/`):

| Measure                                                 | Nov 18 00:05 (`0e861b541a`)            | Parent of F-B4 (`9c142552ee`)                            |
| ------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------- |
| Idle RSS runtime / inclusive                            | 230.5 / 230.5 MiB                      | 229.2 / 229.2 MiB                                        |
| Idle CPU                                                | 1.2 %                                  | 0.9 %                                                    |
| Restart stop / → ready / total                          | 93 / 2,473 / 2,566 ms                  | 137 / 3,128 / 3,265 ms                                   |
| 1 session: latency median, peak RSS runtime / inclusive | 798 ms, 376 / 449 MiB                  | 859 ms, 385 / 459 MiB                                    |
| 4 sessions                                              | 2,104 ms, 436 / 800 MiB                | 2,763 ms, 403 / 772 MiB                                  |
| 8 sessions                                              | 4,023 ms, 447 / 1,230 MiB              | 4,875 ms, 439 / 1,180 MiB                                |
| DB + WAL initial → after cleanup                        | 1.87 → 13.89 MiB (deletes failed then) | 1.87 → 15.09 MiB (deletes work; compaction pending, D-2) |

Runtime memory is flat in sessions, as before (403–439 MiB at 4–8 sessions). Turn latency is
about 15–30 % higher than the earlier run, on the same VM shape; CPU is saturated from 4 sessions,
as before. The HEAD numbers with F-B4 could not be taken because of D-1.

**D-1 evidence** (`live/10`, `live/15`, `live/91`, `live/vm/bbrr-deadlock.*`,
`live/vm/a/trace-bbm.ndjson`):

- **`bbrr`:** three concurrent turns (cascade setup). Thread A's turn completed in the fake at
  16:14:32.415, but its events were never committed.
- From 16:14:33, every `sql.execute` was interrupted at its 5 s timeout, and a client
  `dispatchCommand` hung for 120 s.
- `/proc` showed the backend holding `state.sqlite`, and an external `BEGIN IMMEDIATE` got
  `database is locked`. So the backend's connection holds an open write transaction that is never
  committed.
- The wedge persisted for 16 minutes, until a restart. After the restart, the pending sessions
  were settled and the backend worked again.
- **`bbm`:** the same signature at the 4-session level. The first stuck turn start failed with
  `CommandAdmissionError: orchestration command admission deadline exceeded`.
- **Not reproduced** in 4 other runs with 2–3 sessions (`bbx1`, `bbx2`, `bbc1`, `bbev`).
- **Likely mechanism, not proven:**
  - F-B4 changed 51 by-id reads to `getOrchestrationThread`. On a miss, or on a `history` read of
    a thread whose history is not loaded, that takes the non-reentrant command semaphore.
  - If any such read runs while its fiber already holds the SQL connection or a transaction (the
    order is SQL, then barrier), it deadlocks with a dispatch (barrier, then SQL).
  - It also deadlocks if the fiber already holds the barrier (self-deadlock).
  - The trace does not record unfinished spans, so the holder could not be named. **The owner
    should audit the migrated call sites for calls made inside `withTransaction`,
    `withMetadataTransaction` or the barrier.**
  - Until then, F-B4 should be considered unsafe under concurrent sessions.

### 4. Mobile stage retirement (`cc85ccbbfc`): PASS

**Setup:** account `bbmob`, graph A, mobile inputs loaded. A `tailscale` stand-in is in `fail`
mode, so every activation reaches native Start and the route check and ends `route-unverified`.

**Cycle** (`live/43`): `mobile enable --confirm-consent`, then `mobile activate`, then wait for
`phase idle`, then revoke (`server.updateSettings mobileRemoteControl.enabled=false`).

- **22 activations over 21 consent revisions:**
  - 2 activations in revision 1, then 20 cycles, revisions 3 → 41 (stages `.r3` to `.r41`).
  - Each activation published a new stage, started the native gateway and recorded a confirmed
    exit.
- **No exhaustion:** there was no `stage-budget-exhausted` and no `publication-failed`.
- **Bounded journal:**
  - The journal never held more than **2 stages**, **2 attempts**, **1 history row** and
    **1 release**.
  - There were never more than **2** `components-v1/<key>` directories.
  - `remote-mobile-runtime-v1/` was empty, and **0** gateway processes were left.
  - The `retired` tally grew monotonically, reaching `stages 20, revisionFloor 39, selections 21,
attempts 21`.
- **`mobile repair`:** `1 retired, 1 kept, 1 live`. The current-revision stage was kept as
  `desired`, and the earlier one was retired.

### 5. Late peer refusal (`f49e521f6e`): PASS

Coordinator `bbpc` (A) and worker `bbpw` (W) were paired. The host key was pinned with
`confirmPin:true` (the ed25519 fingerprint matched `ssh-keygen -lf` on W), with grant mode
`approval-required` (`live/50`–`54`). A smoke delegation completed with one delivery.

- **Refusal after the tool returned (the fixed case), `live/60a`–`60c`:**
  - C→W port 22 was dropped with `iptables`. `delegate_to_host` returned `sent-uncertain` after
    5.4 s, and the turn ended.
  - The grant was revoked in the worker backend only (scratch `--authorized-keys`, so SSH still
    works).
  - After the heal, the follower re-sent the delegate. The worker answered `grant-revoked`, and
    dispatch `c664316e` settled `failed`.
  - **One** failure result `peer-result:…` was delivered into the coordinator thread. The thread
    then ran a turn on it.
  - Before the fix, this was `failed` with no delivery.
- **Refusal during the tool's wait, `live/61`:**
  - After a new grant was revoked backend-only, a partition of about 1.5 s was healed while
    `delegate_to_host` was still waiting.
  - The tool returned `failed` (`grant-revoked`), and **no** result was delivered for `24ad7508`.
    So it was reported exactly once.
  - Whether the refusal went through `toolWaits.handOff` or the synchronous refusal path cannot
    be told apart live.

### 6. O-1 installation-id fallback (`79a55b6136`): PASS

**Laptop:** the container has no machine id (`ls` confirms that both files are absent). A
saved SSH project on `bbid@W` gives D5 approval. `server.installRemoteAgent` staged the agent, and
`server.connectRemoteAgent` returned `selected` (`live/81`).

**Before the kill** (`live/82`): `terminal.open` gave remote shell PID 25451, and
`sleep 424242 &` was started in it. The laptop minted `~/.bigbud/identity/installation-v1`: a
`drwx------` directory and a `-rw-------` file of 65 bytes, matching `^[0-9a-f]{64}$`. The file
was not archived.

**`kill -9`** of the laptop backend (`live/83`): the remote shell and `sleep` survived. After a
restart in the same container, the identity file was unchanged (same hash prefix). Then
`terminal.open` **reattached the same shell PID 25451** with a new generation and
`historyUnavailable: true`, and a new write was accepted. The laptop log has **0** `Previous
remote input controller is live or unconfirmed` lines; M2/M3 O-1 had 3 in the same scenario.

### 7. P8 cases a VM can cover: PASS

- **7a. Approval waits on the worker** (`live/70`, `live/71`):
  - A delegate whose task contains `APPROVAL` started a worker child. The child's fake raised
    `requestApproval`, and the worker held a `pending` approval.
  - The coordinator dispatch stayed `following`, without timing out, for 25 s in one run and
    **15.5 minutes** in the other.
  - `thread.approval.respond accept` on the worker let the turn finish. Each dispatch then
    completed with one delivery (`7ed32863`, `5dbe6a52`).
  - **Observation O-A:** `peer_dispatch_status` shows only the dispatch row (`following`). The
    worker's child state `waiting` is used by the follower (it does not settle), but it is not
    shown to the coordinator's model, so the model cannot tell the user that the worker needs an
    approval.
- **7b. Grant expiry** (`live/73*`):
  - A grant was issued with `--expires-days 1` and recorded. A delegate before expiry completed.
  - W's clock was then moved forward 2 days. `lima-guestagent` was stopped first, because the
    first attempt was re-synced by the guest agent within seconds (`INVALID-73b`–`73d`).
  - The next delegate was refused at once: `grant-expired`. The tool returned `failed`, no child
    row was created, and nothing was delivered.
  - The clock and the guest agent were restored afterwards.
- **7c. Republishing `remote-peer.sock`** (`live/72`):
  - `systemctl --user restart` of the worker backend: MainPID 5085 → 10314. The socket inode went
    268801 → 268861, with a new mtime and mode `srw-------`.
  - The next delegation through the SSH forced command completed with one delivery
    (`12299d91`).

## Code changes

| File                                                                     | Change                                                                                                                                                          |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/orchestration/Layers/ReadModelResidencySweeper.ts`      | F-1: one sweep per interval (`Effect.forever(sleep + sweep)` instead of a spaced repeat of `sleep + sweep`); the unused `Schedule` import was removed. 55 lines |
| `apps/server/src/orchestration/Layers/ReadModelResidencySweeper.test.ts` | New `sweeps once per interval` test (TestClock: 1, 2, 3 sweeps after 60, 120, 180 s). 79 lines                                                                  |

**Checks:**

- Explicit-path `bunx oxfmt --check` and `bunx oxlint` on both files: clean.
- `bun run --cwd apps/server typecheck`: exit 0.
- Focused Vitest: `ReadModelResidencySweeper.test.ts`, `OrchestrationEngine.residency.test.ts`,
  `OrchestrationEngine.eviction.test.ts` and `ProviderRuntimeIngestion.eviction.test.ts`, 12/12
  passed.
- **Mutation:** restoring the spaced repeat fails the new test.
- **Live:** graph D swept every 60 s.
- Nothing was committed.

The diagnostic baseline change used for D-2 (graphs C/D) was **reverted**. It changed
`ProjectionPipeline.baseline.ts`, `ProjectionPipeline.baseline.coordination.ts` and three tests.
It is archived as `logs/diagnostic-baseline-change-reverted.diff`.

## Not covered, and why

- **D-1, D-2 and D-3:** the root causes are not fixed. Each needs an owner decision or a deeper
  investigation than a minimal live fix allows (see the sections above).
- **HEAD measurement numbers with F-B4:** blocked by D-1. Numbers were taken on the parent commit
  instead.
- **A late provider event arriving for an already-evicted thread:** cannot be produced with a
  real stopped session (see 3a).
- **The peer in-call refusal path:** `handOff` and the synchronous refusal cannot be told apart
  live.
- **Not covered, as before:** x86_64, a real VPS, a physical phone, real Tailscale Serve, the
  Settings UI, and two physical laptops.

## Evidence

- **Archive:** the run directory `/Users/youpele/.claude/jobs/8ac2e1cd/tmp/rr/` was archived
  (without `src/`, `build/`, `stage*/`, `keys/` or `laptop-in/`) as
  `~/DevWorld/bigbud-evidence/tmp-bigbud-evidence-20261118-unit-only-rerun.tar.zst`, with a
  `.sha256` file.
- **Contents:**
  - `live/`: one log per step. The command is at the top of each log, and voided attempts are
    prefixed `INVALID-`.
  - `live/vm/`: per-account journals, server traces and fake-provider logs, D-1 dumps, the
    O-1 laptop log (lines containing "token" removed), sshd logs and peer tables.
  - `logs/`: builds, hashes, the F-1 diff and the reverted diagnostic diff.
  - `results/`: measurement JSON and markdown.
  - `tools/` and `artifacts/`: public keys and the trust map only.
- **Scans:** the archive was scanned for private-key blocks, the laptop token and the client
  tokens.
- **Teardown:** both VMs were deleted, and the laptop container (which held the only copy of the
  harness private key) was removed. The fixture and harness private keys were deleted from the job
  directory.
