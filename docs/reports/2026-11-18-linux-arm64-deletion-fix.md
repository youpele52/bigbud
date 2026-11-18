# Thread and project deletion on linux/arm64 (F-B11)

**Date:** 18 November 2026
**Finding:** F-B11 in [Remote backend measurements](2026-11-18-remote-backend-measurements.md)
**Related:** [M1 live systemd acceptance](2026-11-17-m1-live-systemd-acceptance.md) (Lima recipe),
[Thread retention](../THREAD_RETENTION.md)
**Status:** Code fix landed in the working tree (uncommitted).

- **Live result:** on aarch64, thread and project deletes now succeed and stay deleted.
- **Still needed:** a schema migration (provided below, not added: migrations are owned
  elsewhere). Without it, every arm64 delete still fails, now with an actionable reason.
- **Separate defect found live:** canonical-history compaction stalls, so after a project cascade
  or a retention delete, the events and some files stay on disk.

## Symptom

On an aarch64 remote backend, every thread delete ended in `thread.deletion-failed`, and project
deletes aborted. Manual deletion and the default 7-day retention therefore freed nothing, and the
database grew without bound. The recorded failure detail was empty.

## Root cause

Deletion is gated on the Rust resource-cleanup executor. Both delete paths prepare it, then
persist a cleanup plan, before anything is committed:

- the thread path: `ProviderCommandReactorHandlers.delete.ts`, `preflight` →
  `cleanupExecutor.prepare()`, then `finalize` → `cleanupRepository.prepare(...)`;
- the project path: `ProviderCommandReactorHandlers.project-delete.ts`.

Any failure aborts the delete (`thread.delete.abort` → `thread.deletion-failed`, or
`project.delete.abort`). On a remote linux/arm64 backend there were **four** independent
blockers. Each one alone causes the failure:

1. **Platform gate.** `deletion/Layers/DirectResourceCleanupExecutor.ts:15` (before the fix)
   admitted only `darwin/arm64`, `darwin/x64`, `linux/x64` and `win32/x64`. `prepare` therefore
   threw `Resource cleanup is unsupported on linux/arm64.` The Rust side was never the problem:
   `--resource-cleanup` is implemented and tested for Linux
   (`crates/bigbud-remote-agent/src/resource_cleanup/unix*.rs`).
2. **No target mapping.** `scripts/lib/workspace-agent-target.ts` had no linux/arm64 entry, so
   `resolveLocalWorkspaceWatchAgentBinary` threw `The local workspace watcher does not support
linux/arm64.`
3. **No binary on a remote backend, on any architecture.** The resolver looks in this order:
   - `BIGBUD_LOCAL_WORKSPACE_AGENT_BINARY`, which the Rust launcher removes with `env_clear()`;
   - a Cargo checkout's `target/debug`;
   - `<server>/workspace-agent/<platform>-<arch>/`, which the backend graph does not contain.

   So linux/x64 remote backends could not resolve a cleanup binary either. This was found by
   reading the code; it was not run on x64.

4. **Schema CHECK (found live).** Once 1–3 were fixed, the executor prepared and ran on arm64. But
   storing the plan failed with `CHECK constraint failed: expected_platform IN ('darwin/arm64',
'darwin/x64', 'linux/x64', 'win32/x64')`. The constraint is in
   `persistence/Migrations/108_DirectResourceCleanupPlans.ts:35`, and no later migration relaxed
   it.

### Why the detail was empty

The reason was lost twice:

- `Data.TaggedError` keeps its fields (`detail`) out of `Error.message`, so `String(error)` returns
  only the tag.
  - `String(new DirectResourceCleanupExecutorError({ detail }))` is
    `"DirectResourceCleanupExecutorError"`.
  - `delete.ts` wrapped every step error as `ThreadDeletionOperationError({ detail: String(error) })`,
    which kept nothing more.
- `ThreadDeletion.deleteNow` stored `Cause.pretty(cause)`. That is
  `"ThreadDeletionOperationError: "` followed by a stack trace with bundle paths.

The `thread.delete.failed` activity therefore had no reason, and the project path logged nothing
when `prepare` failed.

## Fix

- **Actionable, safe detail.**
  - Both error classes expose `detail` as `message`.
  - `deletion/Layers/DeletionFailure.detail.ts` records the first failure's own reason. If the
    error has no `detail`, it uses the root cause of the error's `cause` chain, which is what made
    the live `SqlError` read as the bare constraint. It keeps no stack frames and no path dumps,
    and is capped at 1,000 characters.
  - `toThreadDeletionOperationError` (in `ThreadDeletion.ts`) replaces the five
    `detail: String(error)` wrappers and keeps the original as `cause`.
  - The project path logs the reason when cleanup cannot be prepared.
- **Platform gate.** linux/arm64 is in the supported set. The host can be injected, so a test can
  simulate it.
- **Target.** linux/arm64 entry (`aarch64-unknown-linux-gnu`, Rust identity `linux`/`aarch64`).
  The ELF check now accepts machine `0xb7`.
- **Remote backend: no graph change.** The account service already runs a pinned, verified
  `bigbud-remote-agent`:
  - The Rust launcher hash-checks `rust_binary` against `rust_sha256` at an immutable `0700` path
    before the backend starts.
  - It is the same crate and binary that serves `--resource-cleanup`.
  - The remote preflight passes it as `ServerConfig.workspaceAgentBinaryPath`, and
    `DirectResourceCleanupExecutorLive` hands it to the resolver.
  - The resolver still runs the `--check` identity and protocol verification and the handshake
    capability check.

  Shipping a second copy in the graph would need new files, a loader-policy review and a second
  binary to keep in sync, for no benefit. This also covers linux/x64 remote backends.

- **npm server package and release.** linux/arm64 is now in the shared target table, so the
  published server package needs helpers for it:
  - `release.yml` and `ci.yml` gain `workspace_agent_linux_arm64`. It runs on `ubuntu-22.04-arm`,
    the same glibc baseline as the x64 helpers built on `ubuntu-22.04`, and smoke-tests both
    helpers. It produces `server-workspace-agent-linux-arm64` and
    `server-organization-supervisor-linux-arm64`, which feed the release and assembly jobs.
  - `release-assets.ts` requires both assets.
  - The native cleanup test matrix gains `ubuntu-24.04-arm`.
  - Desktop packaging is unchanged: there is no linux/arm64 desktop build.

Other platforms are unchanged: the supported set only grew, and the existing assets and checks
are untouched.

### Required migration (not added: migrations are owned by another workstream)

Without it, arm64 deletes still fail, now with the reason
`CHECK constraint failed: expected_platform IN (...)`.

- A ready migration and test are in
  `/Users/youpele/.claude/jobs/8ac2e1cd/tmp/arm64-del-migration-proposal/`. The files are named
  176, but the migration should be **177** after `176_PeerChildren`.
- It rebuilds `direct_resource_cleanup_plans` with `rebuildTableSql` and widens the CHECK to add
  `linux/arm64`.
- All six child tables are carried (`resources`, `proofs`, `attempts`, `worktrees`,
  `retained_external`, `retained_unverified`), with `restoreChildObjectsAfterCopy`.
- Its test checks:
  - rows, child rows, indexes and triggers are preserved;
  - a linux/arm64 plan is rejected before the migration and accepted after it;
  - `linux/ia32` is still rejected;
  - plan identity stays immutable;
  - re-running is a no-op;
  - `foreign_key_check` and `integrity_check` pass.
- It passed in both snapshots, as 176 at `f1645c3567` and as 177 at `6716f8b8fe`.
- To add it, register it in `Migrations.ts` (import plus a `migrationEntries` row).

## Tests and checks (working tree)

- **Reproductions, red before the fix:**
  - `ProviderCommandReactor.cleanupPrepareFailure.test.ts` recorded
    `ThreadDeletionOperationError: \n    at …`.
  - `DirectResourceCleanupExecutor.platform.test.ts` threw `does not support linux/arm64`.
- **New tests:**
  - `DeletionFailure.detail.test.ts`, including the live `SqlError` shape;
  - `scripts/lib/workspace-agent-target.test.ts`;
  - linux/arm64 cases in `release-assets.test.ts` and `releaseAssetWorkflows.test.ts`.
- **Results:**
  - Focused Vitest: 18 server files (88 tests) and 6 scripts files (21 tests), covering deletion,
    the reactor delete and project paths, the resolver, remote startup and preflight, the
    executor integration test, packaging and test-group classification. All pass.
  - Explicit-path `oxfmt` and `oxlint`: clean.
  - Typechecks: `apps/server` and `scripts` both exit 0.
- No Rust code changed. All files are within 400 lines.
  `ProviderCommandReactorHandlers.project-delete.ts` is at exactly 400. `ci.yml` is 411 lines,
  but it is workflow YAML, not code.

## Live verification (Lima, aarch64)

**Setup**

- **VM:** `bb-arm64-del` (vz, Ubuntu 22.04 arm64, 2 CPU, 4 GiB, 12 GiB, `mounts: []`, forwards
  ignored). Deleted afterwards.
- **Graph (final):** built from `git archive` of HEAD `6716f8b8fe`, plus this task's 18 files, plus
  the proposed migration as 177. `remote-backend-graph` with the dev fixture key, version
  `0.1.613-dev.arm64del8`, archive sha256 `360ceb8b…fd88`, 8,058 files. **The unmodified HEAD
  loader policy accepted it.**
- **Agent:** musl aarch64, built in a disposable `node:24.13.1-bookworm` container (`--rm`), version
  `0.3.3-arm64del.01872cfe327d`, protocol 1.8, sha256 `3866e86f…b9a3`.
  - It came from the first snapshot, `f1645c3567`. There are no `crates/`, `protocol/` or Cargo
    changes between that commit and HEAD.
- **Service:** fresh `backend setup … --confirm-fresh-setup` and `backend start` for user `bbsvc3`
  (lingering). Both units were Active.
- **Driver:** owner UDS plus client token. It creates a project and threads, writes a provider log
  for each thread (a resource only the Rust executor removes), deletes, and requires the entity
  to stay gone across two 3 s settles.

**Before the migration** (graph at `f1645c3567` without it, user `bbsvc`):

- The thread delete ended in `thread.deletion-failed`. The activity now carried the reason, which
  was the CHECK constraint above.
- The project delete aborted with
  `Thread '…' deletion failed while deleting project '…'.` in the log.

**With the migration (final):**

| Check                                                    | Result                                                                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Thread delete stays deleted                              | **PASS** (gone after 27 ms, still gone after both settles)                                                             |
| Rust executor removes the thread's provider log on arm64 | **PASS**. Plan `expected_platform=linux/arm64`, `completed`; cleanup page took 34 ms                                   |
| Thread's DB footprint                                    | **PASS**: projection row purged, **0** canonical events left                                                           |
| Project delete (cascading a second thread) stays deleted | **PASS** (gone after 301 ms)                                                                                           |
| Manual retention (1-day policy, created-at criterion)    | **PARTIAL**: the 10-day-old thread was deleted and stays deleted; the new thread was kept; the run ended as `deferred` |
| Cascade, project and retention resources and events      | **DEFERRED**: projection rows purged; 3 canonical events each and the provider logs remain (see below)                 |

Evidence: `/tmp/bigbud-arm64-del-20261118T002301Z/`:

- `live/` holds the driver logs (`40-`, `42-`, `45-`, `47-`) and the earlier failing runs (`10-`,
  `11-`).
- `logs/` holds the backend journals, build logs, overlay hashes and the deviation diffs.
- `src/` is a voided first snapshot attempt.

That directory also holds a copy of the dev fixture private key. Delete it, or archive it without
the key.

### Snapshot deviations

- **Migration 177:** snapshot only, described above.
- **Earlier snapshot only** (`f1645c3567`, superseded): to get the graph producer to run, the
  local `require` helper in `runtimeUpdate.operation.ts` was renamed and the SDK pin was changed.
  HEAD `6716f8b8fe` has since fixed the `require` false positive.

## New findings (not fixed here)

- **Canonical compaction stalls after the first baseline (live, high for storage).**
  - After the project cascade, every 5 s the backend logged:
    `canonical cleanup baseline coverage deferred: ProjectionPipeline.ensureBaseline:postcondition
verified baseline did not reach requested sequence 10`.
  - It persisted across a backend restart (47 occurrences in the 4 minutes after it).
  - The only verified baseline stayed at sequence 6, which is thread A's. All 11 projectors,
    `MAX(orchestration_events.sequence)` and the frontier were equal (16), and gaps max was 6.
    So `ProjectionBaselines.createCandidate` returned `none` while its visible inputs agreed.
  - The likeliest lead is the required projector list not matching the 11 `projection_state`
    rows. Another possibility is a memoised failure in
    `ProjectionPipeline.baseline.coordination.ts`, which kept reporting sequence 10 after the
    frontier had moved.
  - Effect: project-cascade and retention plans stay `ready`, so provider logs, notes and kanban
    stay on disk and canonical events are not pruned.
  - This is TypeScript and SQLite only and does not look arm64-specific, but it was not
    reproduced on another platform.
- **Loader-region pin still unstable after `6716f8b8fe`.** The Claude agent SDK region digest
  varies with unrelated bundle contents and between builds:
  - Clean HEAD: `c822c89d…`, which matches the pin.
  - HEAD plus this overlay: `5dd1aace…` twice (with and without the migration).
  - A later rebuild of the same overlay-plus-migration sources: `c822c89d…`.
  - The region code was byte-identical in every case. Only names bound outside the region
    differed (`process$1` ↔ `ob`, `posix$1` ↔ `posix$2`), and the canonical digest still includes
    them.
  - The release producer may therefore refuse a build that contains these changes, depending on
    the run. This needs the policy owner. The pin was not changed in the repo.
- **Project cascade never cleans the cascaded threads' own resources.** The cascade passes
  `directResources: []` for each thread, so their provider logs are not planned. This is
  existing behaviour; it was observed live.

## Left open

- linux musl hosts (for example Alpine): the remote backend uses the static musl agent, so it is
  covered. The npm server package ships a glibc helper, which will not run there; cleanup then
  fails with an actionable "incompatible" detail.
- Remote cleanup requires the agent's protocol to match the backend's exactly (`--check`). Graph
  and agent are released together today. If a future independent agent update changes the
  protocol minor, cleanup will fail visibly, with a detail.
- The local workspace watcher could use the same pinned agent on remote backends; it was not
  changed.
- x86_64 was not run live (no native x64 host).
