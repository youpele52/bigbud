# Remote backend measurements and bounds audit (WP-6A, aarch64)

**Date:** 18 November 2026, 00:05–00:20 UTC
**Plan:** [Remote completion plan](../plans/2026-11-17-remote-completion-plan.md), M5 / WP-6A;
[remote plan](../plans/2026-11-13-remote-agent-manual-install-plan.md), P7 increment 6
**Related:** [M1 live systemd acceptance](2026-11-17-m1-live-systemd-acceptance.md) (Lima recipe
and graph build reused here)
**Status:** arm64 measured on a Lima VM. **x86_64 is still pending** (no native x64 host). The
1 GB and 4 GB VPS rows below are for the user to run.

## Measurement tool

`apps/server/scripts/remoteBackendMeasure.ts` runs on the backend host as the backend's own
account, with the graph's private Node (type stripping; it imports only `node:` modules and the
graph's own `ws`):

```sh
# copy the tool next to the account (tests are not needed on the host)
scp apps/server/scripts/remoteBackendMeasure{,.proc,.client,.sample,.report,.levels,.workload,.fakeCodex}.ts host:~/bbmeasure/
# observe only: /proc, unit PIDs, DB file sizes, handshake and read-only RPCs
~/runtime/backend/runtime/node ~/bbmeasure/remoteBackendMeasure.ts --authority <id>
# the full run used for the numbers below
~/runtime/backend/runtime/node ~/bbmeasure/remoteBackendMeasure.ts --authority <id> \
  --levels 1,4,8 --history-turns 10 --measured-turns 3 --idle-ms 10000 --latency-samples 7 \
  --fake-provider --restart-for-readiness
```

| File                                | Concern                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `remoteBackendMeasure.ts`           | CLI, idle/latency/readiness phases, output                              |
| `remoteBackendMeasure.proc.ts`      | `/proc` process tree: RSS, CPU ticks, runtime-only vs inclusive         |
| `remoteBackendMeasure.sample.ts`    | unit PIDs (`systemctl --user show`), sampling windows, DB sizes, stats  |
| `remoteBackendMeasure.client.ts`    | owner-socket handshake and WebSocket RPC                                |
| `remoteBackendMeasure.levels.ts`    | the 1/4/8-session phase                                                 |
| `remoteBackendMeasure.workload.ts`  | disposable project, threads, turns, cleanup and restore journal         |
| `remoteBackendMeasure.fakeCodex.ts` | fake Codex CLI/app-server (no model, no credentials)                    |
| `remoteBackendMeasure.report.ts`    | dated JSON + markdown summary                                           |
| `remoteBackendMeasure.proc.test.ts` | `measure_tree_includes_children` and CPU-window tests on a fake `/proc` |

**What is measured.** _Runtime-only_ is the backend main process plus the Rust supervisor;
_inclusive_ is both full process trees (provider processes, the workspace agent, PTY shells).
CPU is a percentage of one core averaged over the window. Readiness is measured by
`systemctl --user restart --no-block` of the backend unit only: _stop_ is until systemd reports a
new main PID, _start → ready_ is from then to the first successful handshake. Client reconnect is
WebSocket open + `server.getConfig` + one thread's detail, as a reopening client does. Database
size is `state.sqlite` + `-wal` + `-shm`.

**Workload.** Each session is one thread whose Codex provider is the fake app-server: a real
adapter, ingestion, projection and event-log path, with one provider process per session. Each
turn streams reasoning, a 40-line command execution and an agent message of 40 × 48-character
deltas 10 ms apart (about 2 KB). Sessions accumulate: level 4 reuses level 1's thread and adds
three; every new thread first receives 10 turns of history, then all sessions at that level run 3
measured turns concurrently. The tool waits on one shared thread-summary poll every 250 ms, so its
own RPC load is about one open client, not one per session.

**Safety and what it creates.** Without `--fake-provider` it only reads. With it, it creates:

- `~/bigbud-measure-work-<time>/`: the fake's wrapper (`bin/codex`), the disposable project
  folder (`project/`), an empty `codex-home/`, and `restore-journal.json` (prior Codex settings,
  project and thread ids);
- one project and its threads in the backend, all named `bigbud-measure-*`;
- a temporary change of `providers.codex` (`enabled`, `binaryPath`, `homePath`) to the fake.

Cleanup always runs, also after a failure: it stops the sessions, deletes the threads, verifies
the deletion over a 3 s settle, then deletes the project and restores the Codex settings. A thread
the backend refuses to delete is archived and reported, and the project and work directory are
kept; `--restore <workDir>` replays cleanup from the journal. While it runs, _new_ Codex sessions
on that account use the fake, so on a real VPS run it from a dedicated account or when nobody
starts Codex threads. `--restart-for-readiness` restarts the backend unit once (clients reconnect;
the Rust unit and its terminals survive). Results go to `~/bigbud-measure-results/`.

## Environment and inputs

- **Host:** macOS, Lima 2.3.0. Fresh VM `bb-m5-measure2` (vz, Ubuntu 22.04.5 arm64, kernel
  5.15.0-198), 2 CPUs, 4 GiB memory, 12 GiB disk, `mounts: []`, every port forward ignored. One
  user `bbsvc` with lingering. A first VM (`bb-m5-measure`) was used to develop the tool and was
  deleted; its numbers are superseded and not reported.
- **Source:** `git archive` of HEAD `0e861b541a`; the working tree was not used. Root
  `node_modules` APFS-cloned; workspace `node_modules` copied.
- **Graph:** `bunx tsdown` (both configs), then `bun run remote-backend-graph --target
aarch64-unknown-linux-gnu … --key-id dev-fixture-20261117 --version 0.1.613-dev.m5measure`.
  Archive sha256 `f1c09635…816c2`, buildDigest `b697e50f…10cf9`, 8,048 files.
  - **Deviation (finding F-M5-1):** clean HEAD was refused by the loader policy: the Claude agent
    SDK region (`@anthropic-ai/claude-agent-sdk/sdk.mjs`, same SDK 0.3.310) now hashes to
    `69b7f996…251c49`, not the pinned `1e2e54a3…a079`. The graph was built after changing only
    that pin in the snapshot copy of `build-remote-backend-graph.policy.data.ts`.
- **Rust agent:** disposable `node:24.13.1-bookworm` container (`--rm`), rustup 1.95.0,
  `cargo build --locked --release`, `aarch64-unknown-linux-musl`, version `0.3.3-m5.4914322eb209`,
  protocol 1.8, sha256 `f21e614e…bd3a`. Manifest signed with the dev fixture key; no release key.
- **Backend:** `backend setup … --confirm-fresh-setup`, then `backend start`; measured 60 s after
  start. The measured graph does not contain this task's bounds fixes (they are unit-tested only).

## Results (arm64, 2 CPUs, 4 GiB)

| Measure                                             | Value                           |
| --------------------------------------------------- | ------------------------------- |
| Idle RSS, runtime-only / inclusive                  | 230.5 / 230.5 MiB (3 processes) |
| Idle CPU                                            | 1.2 % of one core               |
| Idle after restart and fake-provider discovery      | 283.1 / 382.7 MiB, 7.3 %        |
| Handshake round trip (median / p95 / max)           | 0.8 / 3.0 / 3.0 ms              |
| Client reconnect, idle (median / p95 / max)         | 14.6 / 33.1 / 33.1 ms           |
| Backend restart: stop / new process → ready / total | 93 / 2,473 / 2,566 ms           |
| First client reconnect after ready                  | 26 ms                           |
| DB + WAL + SHM: initial → after the run             | 1.87 → 13.89 MiB (≈104 turns)   |

| Sessions | Turn latency (median / p95 / max) | Peak RSS runtime / inclusive | Backend main RSS | CPU (runtime / inclusive) | Processes | DB + WAL before → after (WAL) | Reconnect (median / p95) |
| -------- | --------------------------------- | ---------------------------- | ---------------- | ------------------------- | --------- | ----------------------------- | ------------------------ |
| 1        | 798 / 837 / 837 ms                | 376.3 / 448.9 MiB            | 374 MiB          | 69 / 69 %                 | 4         | 6.47 → 6.68 MiB (4.11)        | 13.8 / 20.9 ms           |
| 4        | 2,104 / 2,164 / 2,164 ms          | 436.4 / 800.3 MiB            | 434 MiB          | 97 / 97 %                 | 9         | 8.72 → 9.48 MiB (4.11)        | 9.5 / 36.7 ms            |
| 8        | 4,023 / 4,815 / 5,075 ms          | 446.9 / 1,229.9 MiB          | 444 MiB          | 96 / 97 %                 | 13        | 12.15 → 13.75 MiB (4.17)      | 10.5 / 53.9 ms           |

Reading the numbers:

- **The backend's main thread saturates at four sessions.** CPU is pinned near one core from
  four sessions on, and turn latency grows roughly linearly with sessions (0.8 s → 2.1 s → 4.0 s
  for the same ~0.5 s scripted stream). Throughput, not memory, is the first limit on a 2-CPU host.
- **Runtime memory is flat in sessions:** the backend main process grows from 230 MiB idle to
  374 MiB once a provider has run and to 444 MiB at eight sessions. The Rust supervisor stays at
  about 2 MiB.
- **Inclusive memory is dominated by provider processes.** Each fake Codex process is a Node
  process of 72–76 MiB, so the inclusive column overstates what a real (Rust) Codex costs and
  understates Node-based providers with real work. Treat the runtime-only column as the backend's
  own cost and add the real provider's RSS per session.
- **Storage:** about 70 KB of database per measured turn at eight sessions (1.68 MiB for 24
  turns). The WAL stays at about 4.1 MiB (SQLite's default auto-checkpoint). Deleting threads is
  not possible on arm64 (F-B11), so this space is not reclaimed there.
- An earlier development run on the first VM saw one 10 s backend stop (before any provider had
  run); the final run's stop took 93 ms. Stop time should be watched on the VPS rows.

Evidence: `/tmp/bigbud-m5-measure-20261117T234237Z/` (`results/` holds the tool's JSON and
markdown, `live/` the run logs, `logs/` the build, signing and teardown logs, the backend journal
and the tool's sha256 list). That directory also holds a copy of the dev fixture private key;
delete it or archive without the key.

## Bounds audit

The audit covered orchestration event streams, provider event ingestion, WebSocket and terminal
delivery, remote-agent connections, logs, caches, SQLite retention and compaction, and temporary
space. Sites that are already bounded include orchestration delivery (2,000-event dropping queue
that ends the subscriber), the ordered WS domain stream, the Codex adapter queue (256), terminal
output credit windows and history (1 MiB), ingestion caches (`Cache.make` with capacity and TTL),
command admission (256), attachment orphan sweeps (7 days) and the trace file's rotation.

### Fixed

| Finding                                                                                                                             | Limit                                                                                                                                                   | Test                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Git status: each subscriber of a cwd's `PubSub.unbounded` kept an unbounded backlog (a slow remote client grew it on every refresh) | `GIT_STATUS_SUBSCRIBER_BACKLOG_CAPACITY = 64`, sliding (events carry full state, newest wins)                                                           | `git/Layers/GitStatusBroadcaster.backlog.test.ts`       |
| Effective capability catalogs: a module-global map gained one catalog (up to 100 tracks) per thread ever started, never removed     | `MAX_EFFECTIVE_CAPABILITY_CATALOG_THREADS = 512`, least recently used evicted; set on every turn start, callers already fall back to the static catalog | `capabilities/CapabilityCatalog.dynamic.bounds.test.ts` |
| Remote profile log rotation: the trace file kept the desktop's 10 × 10 MiB (+ active) on small VPS disks                            | `REMOTE_TRACE_MAX_BYTES = 8 MiB`, `REMOTE_TRACE_MAX_FILES = 4` in remote mode (≤ 40 MiB); explicit env values win                                       | `startup/config.traceRotation.test.ts`                  |

Retention needed no new default: data-empty installations, which every fresh remote setup is,
already receive the automatic 7-day thread-retention policy ([Thread retention](../THREAD_RETENTION.md)).
Server logs go to the systemd journal under the remote profile, which journald rotates. The
remote trace defaults are documented in [observability](../development/observability.md).

Checked and not a finding: the trace sink's re-queue on a failed write (`TraceSink.ts`) is
unreachable, because `RotatingFileSink` swallows write errors unless `throwOnError` is set. A full
disk drops trace records instead of growing memory.

### Left as findings (risky or owned elsewhere)

- **F-B11 (live, high): thread and project deletion fail on linux/arm64.** Every delete of a
  measurement thread ended `thread.deletion-failed`. `DirectResourceCleanupExecutor.prepare`
  accepts only `darwin/arm64`, `darwin/x64`, `linux/x64` and `win32/x64`
  (`deletion/Layers/DirectResourceCleanupExecutor.ts:15`), and `scripts/lib/workspace-agent-target.ts`
  has no linux/arm64 target. The recorded error detail is empty. Consequence: on arm64 remote
  backends neither manual deletion nor the default 7-day retention can reclaim anything, so the
  database grows without bound. The fix needs a linux/arm64 cleanup-agent target and a live
  check; whether linux/x64 remote deletion resolves the agent binary was not verified.
- **F-B1:** the provider runtime-event `PubSub.unbounded` (`provider/Layers/ProviderService.ts:101`)
  has about seven subscribers, including one per WebSocket client for thinking deltas
  (`ws/wsStreams.ts:245`, on by default). A slow client grows its own backlog. Bounding it changes
  thinking-preview delivery (drop or resubscribe), which needs the web lane.
- **F-B2:** ingestion `threadWorkers` and command-reactor `aggregateWorkers` keep one fiber and
  unbounded `DrainableWorker` queue per thread or aggregate forever
  (`ProviderRuntimeIngestion.ts:118`, `ProviderCommandReactor.ts:81`); the checkpoint reactor has
  one unbounded queue. Eviction must cooperate with `drain()`.
- **F-B3:** adapter event queues are unbounded for Claude, Copilot, Pi, OpenCode v1, ACP, Devin,
  Cursor and Muse (Codex and OpenCode v2 use 256).
- **F-B4:** the in-memory orchestration read model keeps every hydrated thread
  (`OrchestrationEngine.ts:96`); per-thread contents are capped, the thread count is not.
- **F-B5:** partial-line buffers with no maximum: Pi `RpcProcess.ts` `stdoutBuffer` and Codex
  `readline` without a line limit.
- **F-B6:** unclaimed remote-agent frames (`remote-agent/remoteAgentConnection.ts:363`) have no
  cap; that file is already at 400 lines and needs a split first.
- **F-B7:** no startup sweep of crash-left temp directories (`bigbud-orchestration-mcp-*`,
  `bigbud-pi-orchestration-*`, `bigbud-v2-exec-*`).
- **F-B8:** SQLite sets `journal_size_limit` only in steady-state maintenance, and freed pages are
  returned to the OS only after a user-confirmed rebuild to incremental auto-vacuum.
- **F-B9:** git status broadcaster entries (one small entry per cwd) are never removed.
- **F-B10 (live, not investigated):** after `thread.session.stop` the thread summary still showed
  `sessionStatus: "ready"` for 30 s.
- **F-M5-1:** the loader-policy pin for the Claude agent SDK region no longer matches a clean HEAD
  build (see Environment); the producer refuses HEAD until it is re-reviewed and re-pinned.

## Checks

- `bunx oxfmt` / `bunx oxlint` on the explicit list of changed files: clean.
- `bun run --cwd apps/server typecheck`: no errors in changed files. The only errors are 6 in
  `src/provider-provisioning/provisionAuthority.test.ts`, owned by another lane.
- Focused Vitest: `remoteBackendMeasure.proc.test.ts`, `config.traceRotation.test.ts`,
  `GitStatusBroadcaster.backlog.test.ts`, `CapabilityCatalog.dynamic.bounds.test.ts`,
  `CapabilityCatalog.dynamic.test.ts`, `cli-config.test.ts`,
  `cli-config.persisted-settings.test.ts`: 7 files, 18 tests pass.
- Mutation check (backups under the job's private tmp directory, restored afterwards): an
  unbounded git PubSub, no catalog eviction, a tree walk without children and remote mode using
  desktop trace defaults each made their test fail (5 failing tests, 4 files).

## User M5 checklist

Run the tool (full command above) on each row, on a backend set up from the release graph, and
record the JSON and markdown. "Small DB" is a fresh setup; "large DB" is an account with at least
a few hundred threads of real history (or the tool with `--history-turns 200`). Record free disk
before and after.

| VPS  | Arch   | DB    | Idle RSS / CPU                   | Restart → ready | 1 / 4 / 8 sessions: turn latency, runtime RSS, CPU     | DB growth per turn | Notes                                     |
| ---- | ------ | ----- | -------------------------------- | --------------- | ------------------------------------------------------ | ------------------ | ----------------------------------------- |
| 1 GB | x86_64 | small |                                  |                 |                                                        |                    | watch for OOM at 4/8 (inclusive RSS)      |
| 1 GB | x86_64 | large |                                  |                 |                                                        |                    |                                           |
| 1 GB | arm64  | small |                                  |                 |                                                        |                    | deletion broken (F-B11): cleanup archives |
| 1 GB | arm64  | large |                                  |                 |                                                        |                    |                                           |
| 4 GB | x86_64 | small |                                  |                 |                                                        |                    | first x86_64 numbers                      |
| 4 GB | x86_64 | large |                                  |                 |                                                        |                    |                                           |
| 4 GB | arm64  | small | Lima stand-in: 230.5 MiB / 1.2 % | 2.6 s           | 0.8 / 2.1 / 4.0 s; 376 / 436 / 447 MiB; 69 / 97 / 96 % | ≈70 KB             | this report (VM, not a VPS)               |
| 4 GB | arm64  | large |                                  |                 |                                                        |                    |                                           |

Also check on each VPS: the journald limits (`journalctl --disk-usage`), the trace file stays at
or below 40 MiB under `userdata/logs/`, the backend stop time, and that deleting a thread works on
x86_64 (F-B11).

## Teardown

Both VMs (`bb-m5-measure`, `bb-m5-measure2`) were stopped and deleted; `limactl list` afterwards
shows only another lane's VM, which was not touched. The agent build container ran with `--rm`.
No commit was made.
