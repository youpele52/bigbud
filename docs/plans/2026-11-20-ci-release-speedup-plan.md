# CI and release pipeline speedup plan

| Field                | Value                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status               | Ready for implementation (M1–M4). The user answered every open question (section 13). M5 (ruleset) needs the user's explicit approval at the time it is applied.                |
| Created              | 2026-11-20 12:45 CET (+0100)                                                                                                                                                    |
| Last modified        | 2026-11-20 13:01 CET (+0100), revised with independent plan-reviewer findings and the user's answers                                                                            |
| Project root         | `/Users/youpele/DevWorld/bigbud`                                                                                                                                                |
| Inspected branch/SHA | `dev` @ `6f7246e463` (then `6a09f0c95d` during research; that commit touches no pipeline file). `main` @ `7c610f7923`. No pipeline file differs between `main` and `dev`.       |
| GitHub repository    | `youpele52/bigbud` (public, free GitHub-hosted runners). Always pass `--repo youpele52/bigbud` to `gh`.                                                                         |
| Primary input        | [CI and release pipeline research](../reports/2026-11-20-ci-release-pipeline-research.md), section 5.1 "Adopt now", scoped to the brief's points 1–5                            |
| Related runs         | CI 44693703994 (81.1 min quality job), 44665124768, 44530742001. Release v0.4.0-beta.2 44708446414 (success, 88 min), v0.4.0-beta.1 44675468835 (failed in builds after 58 min) |

---

## 1. Goal and definition of done

**Goal.** CI on `main` and on pull requests reaches a trustworthy verdict in about 20 minutes or less,
and a tagged release finishes in about 30 minutes or less. Correctness and reliability come before
speed: no test, check or platform job may be dropped, and a release must never publish unless the
full CI suite passed for the exact commit being released.

**Definition of done (summary; measurable criteria in section 12).**

1. `ci.yml` is split into parallel jobs, the server `integration` Vitest project runs in runner
   shards with `fileParallelism: false` kept inside each shard, and an always-run `CI passed` job
   is the single verdict.
2. A shard-coverage job proves on every run that every server test file ran exactly once.
3. `release.yml` no longer re-runs the suite in `Preflight`. Builds start within about 3 minutes.
   A `ci_gate` job verifies that `CI passed` succeeded for the tagged SHA, and only the publish job
   waits for it.
4. Builds are not gated on unrelated checks. Only assembly (CI) and publish (release) wait.
5. Hygiene: PR-only cancellation, `timeout-minutes` on every job, cache saves only from `main`,
   Playwright and Electron download caches, every action pinned to a commit SHA, and a recorded
   decision on Turbo `cache: false`.
6. Each milestone lands through a draft PR that an actual CI run validates, with a rollback path.

---

## 2. Background and evidence

### 2.1 Measured baseline (gh run data, 2026-11-20)

CI (`ci.yml`, every recent run is a `push` to `main`; there are no PR runs in the last 200):

| Run         | Wall   | Quality job | Typecheck | Test step | Desktop builds after quality                                |
| ----------- | ------ | ----------- | --------- | --------- | ----------------------------------------------------------- |
| 44693703994 | 99 min | 81.1 min    | 6.8 min   | 68.6 min  | mac x64 14.2, Windows 16.5, Linux 6.4, mac arm64 4.8 min    |
| 44665124768 | 91 min | 64.5 min    | 4.6 min   | 49.5 min  | mac x64 **23.9**, Windows 17.1 min (Playwright install 5.5) |
| 44530742001 | 85 min | 61.9 min    | –         | –         | mac x64 21.2, Windows 14.5 min                              |

Side jobs that already run in parallel: native cleanup ×5 (0.7–3.5 min), mount boundary 0.8,
Windows CUA sweep 5.7–6.9, release smoke 0.7, bootstrap installer smoke 0.3, NSIS cleanup 0.5.
Release asset assembly 1.3–2.2 min.

Inside the 68.6-minute test step of run 44693703994 (log analysis):

| Turbo task                     | Files | Notes                                                                               |
| ------------------------------ | ----- | ----------------------------------------------------------------------------------- |
| `@bigbud/server:test`          | 2,389 | 3,935 s (65.6 min). `unit` 614 files (parallel), `integration` 1,776 files (serial) |
| `@bigbud/web:test`             | 743   | 524 s, sharing the 4-vCPU runner with server tests                                  |
| desktop, shared, mobile-web, … | ~470  | 1–1.8 min each                                                                      |
| `^build` before server tests   | –     | contracts + web build, about 3 min before `server:test` starts                      |

Integration file timing: reported per-file test durations sum to 36.7 min. The rest of the 65 min
is per-file import and setup (about 1 s per file). The slowest file is 56 s
(`EventLogMaintenance.scale.test.ts`).

Release (`release.yml`; all 100 recent runs are tag pushes):

| Run                        | Wall   | Preflight | Critical path after preflight                                                                  |
| -------------------------- | ------ | --------- | ---------------------------------------------------------------------------------------------- |
| 44708446414 (beta.2, ok)   | 88 min | 57.6 min  | mac x64 build **26.1 min**, Windows 19.1, publish 2.6                                          |
| 44675468835 (beta.1, fail) | 81 min | 58.6 min  | both `remote_backend_graph_build` jobs failed at +1.4 min; macOS builds failed at +7.8–7.9 min |
| 42470393458 (v0.3.3, ok)   | 75 min | 41.6 min  | Windows 21.3 min                                                                               |

Beta.1 had two independent failures. (1) Both `remote_backend_graph_build` jobs failed in "Build
remote backend graph". That is the release-signing path (`release_signing: true`), whose dirty-tree
provenance check refused the release version stamp; commit `7c610f7923` later allowed that stamp.
(2) Both macOS desktop builds failed in "Build desktop artifact" because the Apple Developer
Program License Agreement had not been accepted (beta.2 release report). Both problems surfaced
within 8 minutes of the builds starting, but only 60–66 minutes after the tag, because of the serial
preflight. CI never exercises the release-signed graph path: CI and PR runs of
`release-remote-backend-graph.yml` sign with an ephemeral fixture key.

Tag/CI relationship (evidence for the gate design): beta.2 (`7c610f7923`), beta.1 (`61d3275d47`)
and v0.3.3 (`97cc2dab87`) were all tagged on `main` commits that have a `push` CI run. v0.3.3's tag
and CI runs were created 1 second apart, so a gate must also handle CI still being in progress.

### 2.2 Shard behaviour (open question Q1 from the research)

Read from the installed Vitest 4.1.5 (`node_modules/vitest/dist/chunks/coverage.DM_a_rWm.js`,
`cli-api.Cjt90eJu.js`):

- Sharding runs inside `executeTests` after project filtering. `BaseSequencer.shard()` sorts the
  file specifications by SHA-1 of the path relative to the project root and takes one contiguous
  slice per index (`calculateShardRange`). The hash covers the path only, not the project name.
- The `unit` and `integration` projects are disjoint by construction (`include: unitFiles` vs
  `exclude: unitFiles`), so `--project integration --shard i/N` partitions exactly the integration
  files.
- `vitest list --filesOnly` does **not** apply `--shard` (it calls `getRelevantTestSpecifications`
  directly). Non-`filesOnly` `list` does apply it, but it imports every file serially (about 30 min).
  So shard membership must be verified from the shard runs themselves.
- The JSON reporter writes one `testResults` entry per test module, including fully skipped files
  (`name: file.filepath`), plus per-status counts. That makes it a good source for the check.

Local read-only evidence: `bun run --cwd apps/server vitest list --filesOnly --json=/tmp/...`
listed 2,390 files (`unit` 614, `integration` 1,776), and the worktree was unchanged afterwards. An
offline re-implementation of the hash partition put every integration file into exactly one of 8
shards (222 each). Estimated test time per shard, using CI durations plus 1 s overhead per file, is
7.8–9.1 min for 8 shards and 5.6–7.5 min for 10.

### 2.3 Hidden dependencies the monolithic job provided (must be preserved)

1. **Rust debug binaries.** The monolith ran `cargo test --workspace` before `bun run test`, which
   leaves debug binaries in `target/debug/`. These JS tests use them:
   - Skipped silently when the binary is missing (`it.skipIf(!existsSync(binary))`):
     `apps/server/src/thread-organization/organizationNative.process.test.ts`,
     `organizationBridge.engine.test.ts`, `organizationBridge.load.engine.test.ts`,
     `organizationRecovery.process.test.ts`,
     `apps/server/src/orchestration/Layers/ThreadOrganizationReactor.snoozeRecovery.test.ts`,
     `apps/desktop/src/system-monitor/agentBridge.realChild.test.ts`,
     `bridge.app.realChild.test.ts`, `apps/desktop/src/computer-use/guardProcess.test.ts`,
     `scripts/lib/thread-organization-smoke.test.ts`.
   - Fail without a binary: `apps/server/src/deletion/Layers/DirectResourceCleanupExecutor.integration.test.ts`
     (debug or release `bigbud-remote-agent`), and
     `apps/desktop/src/backend/ownershipRecovery.integration.test.ts` (uses
     `target/debug/bigbud-desktop-supervisor` on macOS/Linux with no skip if it is missing).
   - `target/release` presence was checked and is not needed by tests: only
     `DirectResourceCleanupExecutor` falls back to release, and the debug binary exists after
     `cargo test --no-run`. (`target/release` matters for builds; see item 5.)
   - Run `cargo build --locked --package bigbud-remote-agent` in `beforeAll`, so they need the Rust
     toolchain and protoc: `apps/server/src/remote-agent/localWorkspaceWatch.integration.test.ts`,
     `localWorkspaceSearch.integration.test.ts`.

   A split job without Rust would turn several of these into **silent skips**, so test jobs must
   rebuild the same binary set (M2 step 3).

2. **Playwright Chromium.** Four server `integration` files import `playwright`
   (`wsRpcHandlers.terminalAnsiRecovery.browser.test.ts`, `Manager.recoveryModel.browser.test.ts`,
   `TerminalRecoveryModel.savedCursor.browser.test.ts`, `TerminalRecoveryModel.tui.test.ts`). No
   non-server Vitest file imports Playwright. The `test:browser` suites for web and mobile web are
   separate scripts and are **not** in CI today.
3. **Turbo strict env mode and `^build`.** `bun run test` → `turbo run test`. Turbo 2.11.5 defaults
   to strict env mode (tasks see only the `globalEnv`/passthrough variables), and `test` depends on
   `^build` (for the server: contracts and web builds, because `@bigbud/web` is a devDependency).
   Running Vitest directly would change both the environment and the prerequisites, so shard jobs
   run the server tests **through Turbo** (M2 step 1).
4. **Full lifecycle install.** `node scripts/bun-install-with-retry.ts` runs lifecycle scripts,
   including the `prepare` hooks that patch `@effect/language-service`. Typecheck depends on that
   patch. Every Linux JS job keeps this install.
5. **Rust in the `@bigbud/server` build.** `bun run --cwd apps/server build` (`scripts/cli.ts`
   lines 186–195) stages native helpers. It runs `cargo build --locked --release --package bigbud-remote-agent`
   (`apps/server/scripts/workspaceAgent.ts` lines 45–52) and
   `cargo build --locked --release --package bigbud-desktop-supervisor`
   (`organizationSupervisor.ts` line 36). `rust-toolchain.toml` pins 1.95.0. In the monolith,
   `bun run build:desktop` took only 35 s because `cargo build --workspace --release` (`ci.yml`
   lines 61–62) had already filled `target/release`. Every job that builds `@bigbud/server` therefore
   needs Rust and protoc, which in the target graph is `build_desktop_pipeline`. No test task depends
   on the server build: no workspace package depends on `@bigbud/server`, and in the baseline log
   `@bigbud/server:build` runs only in the `build:desktop` step. On a cold target the two release
   builds add about 2–4 min.

### 2.4 Tests that assert workflow structure (must keep passing)

- `apps/server/scripts/releaseAssetWorkflows.test.ts` (`unit` project): in both `ci.yml` and
  `release.yml`, `workspace_agent_windows_arm64` and `workspace_agent_linux_arm64` stay as job IDs
  with their runners and commands. The consumer job (`release_asset_assembly` / `release`) `needs`
  them. In `ci.yml` the producer `if` equals the consumer `if`. `native_resource_cleanup` matrix
  includes `ubuntu-24.04-arm`. Steps are matched with `uses.startsWith("actions/upload-artifact@")`,
  so SHA pins keep working.
- `apps/server/scripts/releaseAssetWorkflows.notices.test.ts`: release remote-agent notice steps and
  `softprops/action-gh-release@` prefix.
- `scripts/release-smoke.ts` (CI `release_smoke` job): `release.yml` contains
  `uses: ./.github/workflows/release-desktop-build.yml` and `secrets: inherit`, the publish job key is
  exactly `\n  release:\n` and contains `bun install --frozen-lockfile --ignore-scripts`, and
  `ci.yml` must never contain `secrets.APPLE_` or `--signed`.

---

## 3. Plan assumptions

| #   | Assumption                                                                                                               | Evidence                                                                           | How to verify                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| A1  | Free public-repo limits: 20 concurrent jobs and 5 concurrent macOS jobs per account; 10 GB cache per repository          | GitHub docs (https://docs.github.com/en/actions/reference/limits), read 2026-11-20 | Re-read before M3; watch queued times in M3 runs                         |
| A2  | `ubuntu-24.04` public runners have 4 vCPU, so per-runner timings in 2.1 carry over                                       | Monolith timings                                                                   | Compare M2 shadow timings                                                |
| A3  | Release tags are created on `main` commits that get a `push` CI run                                                      | Section 2.1                                                                        | OQ-1; the gate also offers a `workflow_dispatch` route for other commits |
| A4  | `turbo run test --filter=!@bigbud/server` selects every package with a `test` script except the server                   | Turbo filter docs (negation removes from the selection); not yet run here          | Step 4.1 `--dry=json` check                                              |
| A5  | Electron caches follow `electron_config_cache` (postinstall via `@electron/get`) and `ELECTRON_CACHE` (electron-builder) | Tool documentation from memory; not verified in this repository                    | M1: on a cache hit the install/build log shows no Electron download      |
| A6  | A `workflow_dispatch` run started with `--ref <branch>` uses that branch's workflow file and inputs                      | GitHub behaviour; not exercised in this repository                                 | M4 dry run: the run's YAML (`gh run view --json`) shows the new input    |

---

## 4. Scope

**In scope** (the research's "adopt now" points 1–5):

1. Release: no serial suite in `Preflight`. Builds start immediately, and a gate verifies CI on the
   exact SHA. Only publish waits.
2. Shard the server `integration` project across runners (`fileParallelism: false` kept), with
   verification and a fallback.
3. Split the monolithic CI job into parallel jobs, plus one always-run `CI passed` aggregate.
4. Do not gate builds on unrelated checks. Only CI assembly and release publish wait.
5. Hygiene: PR-only `cancel-in-progress`, `timeout-minutes` everywhere, cache saves only from `main`,
   Playwright and Electron download caching, SHA-pinned actions, and a decision on Turbo `cache: false`.

Files in scope: `.github/workflows/ci.yml`, `release.yml`, `release-desktop-build.yml`,
`release-remote-agent-build.yml`, `release-remote-backend-graph.yml`, new
`.github/actions/setup-bigbud/action.yml` and `.github/actions/setup-rust-native/action.yml`, new
scripts and tests listed in section 7, `package.json` and `apps/server/package.json` scripts,
`justfile`, and `docs/COMMANDS.md`.

**Out of scope / non-goals:**

- Duration-weighted sharding (research C4), test-result caching (C5), affected-only PR gating (C3).
- Building Windows on Linux (C2), building macOS x64 on arm64 (C1), notarisation via API key (C6).
  These are the follow-ups if the release target is still missed (section 11).
- Adding web/mobile-web `test:browser` suites to CI (new coverage, OQ-6).
- Removing the release native-cleanup or CUA sweep duplicates (research A8).
- Pinning actions in workflows outside the five pipeline workflows (`pr-size.yml`, `pr-vouch.yml`,
  `issue-labels.yml`, `opencode-v2-shared.yml`, `inyosira-windows-qualification.yml`): follow-up.
- `persist-credentials: false`, build/sign separation, checksums/provenance (A9 partial, C7, C9).
- Copying t3code workflows (pnpm, Blacksmith runners, private task cache).
- Classic branch protection. The required check is instead planned as an M5 ruleset with owner
  bypass (OQ-4). That is a repository setting, applied only with the user's explicit approval.

**Behaviour that must remain unchanged:**

- Every check and test the monolith and release preflight ran still runs, on the same OS images,
  with the same install mode, the same Rust binaries available and the same Turbo env filtering.
- Native cleanup (5 platforms + mount boundary), Windows CUA sweep, release smoke, installer smokes,
  desktop preview builds and assembly on `main`, and the release native cleanup jobs.
- Release build and sign steps, asset names, updater manifests, signed manifests and published
  file lists. CI stays unsigned (no `secrets.APPLE_`, no `--signed`).
- Server test grouping (`unit` parallel, `integration` serial, the guard setup file, manifests).
- `main` pushes and release runs are never cancelled.

---

## 5. Repository findings

| Area                 | Finding                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml` (411 lines) | One `quality` job (fmt, Rust fmt/clippy/test/release build, lint, typecheck, Playwright, `bun run test`, `build:desktop`, preload check). Side jobs in parallel. Desktop builds and ARM agents `needs: quality` (+ cleanup and CUA for desktop builds). |
| `release.yml` (399)  | `permissions: contents: write` at top level. `preflight` runs fmt, lint, typecheck, Rust and full `bun run test`. `build` needs preflight + native cleanup. Publish job `release` needs every build. No concurrency key.                                |
| Reusable workflows   | `release-desktop-build.yml` (signing, notarisation, smokes), `release-remote-agent-build.yml`, `release-remote-backend-graph.yml` (also `pull_request` with paths, `workflow_dispatch`). None has timeouts.                                             |
| Caching today        | One `actions/cache@v5` in `quality`: `~/.bun/install/cache` + `.turbo`, key `bun.lock` + `turbo.json`, saved on every event. Because the key changes only with the lockfile, the `.turbo` content is effectively frozen. Repository cache use: 1.2 GB.  |
| `turbo.json`         | `test` and `typecheck` are `cache: false`; `build` is cacheable. No `globalDependencies` and no task `inputs`.                                                                                                                                          |
| Server Vitest config | `apps/server/vitest.config.ts`: projects `unit` (manifest `vitest.unit-files/*.txt`, guard setup, parallel, `groupOrder: 0`) and `integration` (everything else, serial, `groupOrder: 1`), `testTimeout`/`hookTimeout` 60 s.                            |
| Versions             | Vitest 4.1.5, Turbo 2.11.5, Playwright 1.59.1 (in `apps/server`), Electron 40.6.0, electron-builder 25.1.8, Rust 1.95.0, Bun 1.3.9, Node 24.13.1.                                                                                                       |
| Repository settings  | `main` is not protected, there are no rulesets, `sha_pinning_required: false`, and work lands on `main` by direct (squash) pushes from `dev`.                                                                                                           |
| Reuse targets        | `scripts/bun-install-with-retry.ts` (install), `scripts/lib/release-metadata.ts` (preflight), `apps/server/scripts/serverTestGroups.manifest.ts` (group semantics), `releaseAssetWorkflows.test.ts` (pattern for YAML assertion tests with `yaml`).     |
| Command docs         | `docs/COMMANDS.md` + `justfile` (344 lines) must list every new Bun script. Bun scripts are the source of truth.                                                                                                                                        |

---

## 6. Current-state map

```
ci.yml  (pull_request, push: main)                                  [no concurrency, no timeouts]
├─ quality  "Format, Lint, Typecheck, Test, Build"  ubuntu-24.04    62–81 min  ← critical path
├─ release_smoke · bootstrap_installer_smoke (win) · nsis_installer_scripts (win)       ≤1 min
├─ windows_cua_sweep (win)                                                             6–7 min
├─ native_resource_cleanup ×5 (2 macOS) · native_resource_cleanup_mount             1–3.5 min
└─ main push only:
   ├─ desktop_release_build ×4  needs [quality, cua, cleanup, mount]   start +62–81, 5–24 min
   ├─ workspace_agent_windows_arm64 / linux_arm64  needs quality                  1–4.5 min
   └─ release_asset_assembly  needs [desktop ×4, arm agents, release_smoke]        1.3–2.2 min
Wall: 85–99 min (main).

release.yml  (tag v*.*.*, workflow_dispatch version)                [contents: write everywhere]
├─ preflight  (metadata + fmt + lint + typecheck + Rust + full tests)     42–58 min  ← serial
├─ native_resource_cleanup ×5 · mount                needs preflight          1–2 min
├─ build (reusable desktop ×4)                       needs preflight + cleanup   7.5–26 min
├─ remote_agent_build ×4 · remote_backend_graph_build ×2 · workspace agents ×2   1–5 min
└─ release (publish)  needs preflight, build, remote builds, agents           2.6 min
Wall: 62–88 min.
```

---

## 7. Target design

### 7.1 Target `ci.yml` job graph

Triggers: `pull_request`, `push` to `main`, and new `workflow_dispatch` (lets a maintainer qualify
any branch head for the release gate).

```yaml
concurrency:
  group: ci-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || format('run-{0}', github.run_id) }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

A unique group per non-PR run matters: GitHub cancels a _pending_ run in the same group even when
`cancel-in-progress` is false, so `main` and dispatch runs must not share a group.

| Job ID                          | Name                                 | Runner           | Needs                                         | Est.  | Timeout |
| ------------------------------- | ------------------------------------ | ---------------- | --------------------------------------------- | ----- | ------- |
| `fmt_lint`                      | Format and lint                      | ubuntu-24.04     | –                                             | 2     | 15      |
| `typecheck`                     | Typecheck                            | ubuntu-24.04     | –                                             | 8     | 25      |
| `rust`                          | Rust format, lint, test, build       | ubuntu-24.04     | –                                             | 5     | 25      |
| `build_desktop_pipeline`        | Build desktop pipeline (needs Rust)  | ubuntu-24.04     | –                                             | 5–7   | 20      |
| `test_packages`                 | Test packages                        | ubuntu-24.04     | –                                             | 10–13 | 30      |
| `test_server_unit`              | Test server unit                     | ubuntu-24.04     | –                                             | 6     | 20      |
| `test_server_integration`       | Test server integration ${{shard}}/8 | ubuntu-24.04 ×8  | –                                             | 15–17 | 35      |
| `test_server_shard_coverage`    | Verify server test shard coverage    | ubuntu-24.04     | `test_server_unit`, `test_server_integration` | 1–2   | 10      |
| `release_smoke`                 | (unchanged)                          | ubuntu-24.04     | –                                             | 1     | 10      |
| `bootstrap_installer_smoke`     | (unchanged)                          | windows-latest   | –                                             | 0.5   | 10      |
| `nsis_installer_scripts`        | (unchanged)                          | windows-2022     | –                                             | 0.5   | 10      |
| `windows_cua_sweep`             | (unchanged)                          | windows-2022     | –                                             | 7     | 20      |
| `native_resource_cleanup`       | (unchanged) ×5                       | mixed            | –                                             | 1–3.5 | 20      |
| `native_resource_cleanup_mount` | (unchanged)                          | ubuntu-24.04     | –                                             | 1     | 15      |
| `ci_passed`                     | **CI passed**                        | ubuntu-24.04     | every job above (`if: always()`)              | <0.5  | 5       |
| `desktop_release_build`         | (main push only) ×4                  | mixed            | **none**                                      | 5–24  | 45      |
| `workspace_agent_windows_arm64` | (main push only)                     | windows-11-arm   | **none**                                      | 4.5   | 20      |
| `workspace_agent_linux_arm64`   | (main push only)                     | ubuntu-22.04-arm | **none**                                      | 1     | 20      |
| `release_asset_assembly`        | (main push only)                     | ubuntu-24.04     | `ci_passed`, desktop ×4, both ARM agents      | 1.5–2 | 15      |

`ci_passed` passes only if the `needs` object has exactly the expected number of entries (or the
expected job-ID list) **and** every needed job's `result == "success"`. The count check matters
because `jq all()` is vacuously true on an empty object. A skipped or cancelled need fails it, and
no needed job may use `continue-on-error`. The only conditional need is `test_server_shard_coverage` (`if: !cancelled()`), and it
is skipped only when the run was cancelled, so no skip exceptions are required. It writes a
result table to `$GITHUB_STEP_SUMMARY`. The desktop preview builds are deliberately **not** in
`ci_passed`: they produce unsigned preview artifacts, they never ran in release preflight, and
including them would tie the verdict (and the release gate) to the 12–24-minute macOS x64 Intel
build.

Expected verdict time: about 16–19 min (the slowest shard plus up to 2–3 min of queueing). On `main`,
the full run ends at about max(verdict, macOS x64 preview build 12–24 min) + assembly 2 ≈ 18–27 min.

**Concurrency budget.** Jobs without `needs` start at t=0:

- PR: 14 new Linux jobs (`fmt_lint`, `typecheck`, `rust`, `build_desktop_pipeline`,
  `test_packages`, `test_server_unit`, 8 shards) + 4 existing smoke/CUA jobs + 6 native cleanup jobs
  = **24** (4 queue). `test_server_shard_coverage` and `ci_passed` start later, so a PR run has 26 jobs.
- `main` push: 24 + 4 desktop preview builds + 2 ARM agents = **30** at t=0 (10 queue), 33 in total
  including coverage, `ci_passed` and assembly. macOS at t=0: 2 cleanup + 2 preview builds = 4
  (limit 5).

Most queued jobs wait behind jobs that take ≤ 2 minutes (native cleanup, smokes, `fmt_lint`). The
limits are per account, so runs in other repositories also count.

Worst cases (`main` and release runs are never cancelled, by design):

- **Overlapping `main` pushes.** Pushes can come fast. For example, the runs 44652626476,
  44653615297, 44655141026 and 44657660022 were all created within 42 minutes. At the old runtimes
  they barely overlapped because they failed early, but with about 20-minute runs, pushes spaced
  under 20 minutes apart overlap. Two overlapping `main` runs need about 60 jobs and 8 macOS jobs
  (limit 5). The second run's verdict can then slip by roughly one job duration, typically 5–15 min.
  The macOS native-cleanup jobs (1–3.5 min) are part of the verdict, so a macOS queue behind
  preview builds (up to 24 min) can delay `CI passed` by that much in the worst case.
- **Tag pushed during `main` CI.** That adds 19 release jobs (4 macOS), and `ci_gate` holds one
  Linux slot for up to 70 min while it polls. Everything remains correct but slower. The runbook is
  to tag after `CI passed`.
- Mitigations, if measured queue delay matters: space pushes to `main`, or move the macOS
  native-cleanup jobs out of the verdict (not recommended: it weakens I-2). Accept and document the
  worst case first. M3 validation measures queueing, including a back-to-back push.

### 7.2 Target `release.yml` job graph

```
release.yml  (tag v*.*.*; workflow_dispatch: version, publish=false)   top-level permissions: contents: read
├─ preflight  "Preflight"  (checkout, bun, node, install --ignore-scripts, resolve metadata)  ~1.5 min, timeout 15
├─ ci_gate  "CI passed for release commit"  needs preflight   permissions: {actions: read, contents: read}
│     node scripts/wait-for-ci-verdict.ts  (no secrets, no install)                              timeout 75
├─ native_resource_cleanup ×5 · native_resource_cleanup_mount   needs preflight (unchanged)       timeout 20/15
├─ build (reusable desktop ×4)            needs preflight ONLY                                     jobs timeout 90
├─ remote_agent_build ×4 · remote_backend_graph_build ×2   needs preflight (unchanged)             jobs timeout 30
├─ workspace_agent_windows_arm64 · workspace_agent_linux_arm64   needs preflight (unchanged)       timeout 20
└─ release  "Publish GitHub Release"
      needs: preflight, ci_gate, native_resource_cleanup, native_resource_cleanup_mount, build,
             remote_agent_build, remote_backend_graph_build, workspace_agent_windows_arm64,
             workspace_agent_linux_arm64
      if: github.event_name == 'push' || inputs.publish == true      permissions: contents: write   timeout 30
```

There is no `concurrency` key in any release workflow, so nothing can cancel a release, including
a queued one. Release workflows restore no `actions/cache` caches (settled decision D-8).

Expected release wall time for a tag on an already-verified commit: preflight 1.5 + reusable
workflow start 0.5 + macOS x64 build/notarise 12–26 + publish 2.6 ≈ **17–31 min**. The critical
path is macOS x64 on `macos-15-intel`. Concurrency: 19 jobs after preflight, 4 of them macOS.
`ci_gate` occupies one Linux slot for as long as it polls (seconds when CI has already passed, up
to 70 min otherwise). Tagging while `main` CI is still running is still correct (the gate waits),
but runs queue against the 20-job and 5-macOS limits (section 7.1 worst cases). The runbook is: tag
after `CI passed`.

### 7.3 Release gate logic (`scripts/wait-for-ci-verdict.ts`)

Inputs: `--repo`, `--sha` (`needs.preflight.outputs.ref`), `--workflow ci.yml`,
`--job "CI passed"`, `--timeout-minutes 70`, `--missing-grace-minutes 10`, `--poll-seconds 30`.
Token: `GITHUB_TOKEN` (job permission `actions: read`). Uses only Node built-ins (`fetch`), so the
job needs only checkout and setup-node.

Before polling, the job asserts that `git rev-parse HEAD` equals the `--sha` being verified. The
checkout and the gate input must name the same commit, otherwise the job fails immediately.

Each poll:

1. `GET /repos/{repo}/actions/workflows/ci.yml/runs?head_sha={sha}&per_page=100`.
2. Candidates: runs with `head_sha == sha`, `head_repository.full_name == repo` and
   `event ∈ {push, workflow_dispatch}`. `pull_request` runs are **never** accepted: they test a
   merge commit, not the tagged SHA.
3. For each candidate: `GET /repos/{repo}/actions/runs/{id}/jobs?filter=latest&per_page=100`, then
   find the job named exactly `CI passed`.
4. Pure decision function (in `scripts/lib/ci-verdict.ts`, unit-tested):
   - Some candidate's latest-attempt `CI passed` job is `completed/success` → **pass**. Print the
     run URL to the step summary.
   - Otherwise, if some candidate run is not `completed` → **wait**.
   - Otherwise, no candidates and elapsed < missing grace → **wait**. After the grace →
     **fail** with: `No CI run for <sha>. Run: gh workflow run ci.yml --repo <repo> --ref <tag or branch>`,
     then re-run this release's failed jobs.
   - Otherwise (every candidate completed, none passed, including a run whose conclusion is success
     but has no `CI passed` job) → **fail** and list each run's conclusion.
   - Overall deadline reached → **fail**. API or network errors are retried with backoff inside the
     deadline and never count as a pass.

Recovery path: when the gate fails, fix or re-run CI, then use "Re-run failed jobs" on the release
run. The successful build jobs and their artifacts are kept, so only `ci_gate` and publish run again.

### 7.4 Shard coverage check (`scripts/verify-test-shard-coverage.ts`)

Inputs: `--expected <vitest list --filesOnly JSON>`, `--unit <unit JSON report>`,
`--shards-dir <dir with integration-<i>.json>`, `--shard-count N`, `--package-dir apps/server`.
The coverage job downloads all `server-test-report-*` artifacts with `actions/download-artifact`
`merge-multiple: true` into one flat directory (`$RUNNER_TEMP/server-test-reports`), which the
script reads non-recursively.
Paths are normalised to the suffix after `apps/server/`, so different runner roots compare correctly.

Fails when: a shard report is missing; an expected `integration` file appears in zero or more than
one shard report; an expected `unit` file is missing from the unit report; a report contains a file
that is not expected or appears under the wrong project; or a report records failures. (The last
case only adds a clearer message; the shard job fails anyway.)

It prints totals (files; tests passed, failed, skipped/pending, todo) to the step summary so they can
be compared with the monolith in shadow mode.

---

## 8. Safety invariants

| ID   | Invariant                                                                                                                                                                                                                                                                       | Enforced by                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| I-1  | A release never publishes unless `CI passed` succeeded for the exact commit being released                                                                                                                                                                                      | `release.needs` includes `ci_gate`; gate decision function; `ci_passed` requires all-success; workflow invariant test  |
| I-2  | `CI passed` covers at least everything the old preflight ran (fmt, lint, typecheck, Rust fmt/clippy/test, full Vitest suite incl. Playwright tests)                                                                                                                             | Job list in 7.1; shard coverage check; invariant test asserting `ci_passed.needs`                                      |
| I-3  | Every server test file runs exactly once per CI run                                                                                                                                                                                                                             | `test_server_shard_coverage` on every run, and it is in `ci_passed.needs`                                              |
| I-4  | Signing secrets appear only in signing/publish jobs (`build` via `secrets: inherit`, `remote_backend_graph_build`, `release`). `preflight` and `ci_gate` get none. CI has none.                                                                                                 | Invariant test scanning `release.yml` for `secrets.`; `release-smoke.ts` CI check                                      |
| I-5  | `main`, `workflow_dispatch` and release runs are never cancelled by concurrency                                                                                                                                                                                                 | `ci.yml` group uses `run_id` for non-PR runs; release workflows have no `concurrency`; invariant test                  |
| I-6  | Caches are written only by `push` runs on `main`; release workflows restore no caches                                                                                                                                                                                           | `actions/cache/save` steps guarded by `github.event_name == 'push' && github.ref == 'refs/heads/main'`; invariant test |
| I-7  | Every non-reusable job has `timeout-minutes`, and every third-party action is pinned to a 40-hex commit SHA                                                                                                                                                                     | Invariant test (reusable-workflow caller jobs cannot take `timeout-minutes`; the called jobs carry it)                 |
| I-8  | Test jobs have the same prerequisites as the monolith: lifecycle install, Turbo strict env + `^build`, Rust debug binaries from `cargo test --no-run`, Playwright in integration shards; `build_desktop_pipeline` has Rust + protoc for the server build's release cargo builds | Composite actions + job steps; shadow comparison in M2                                                                 |
| I-9  | Builds never wait for tests; only `release_asset_assembly` (CI) and `release` (publish) wait                                                                                                                                                                                    | Invariant test: main-only build jobs have no `needs`; release `build.needs == [preflight]`                             |
| I-10 | `workflow_dispatch` releases publish only with an explicit `publish: true`                                                                                                                                                                                                      | Publish `if` uses `inputs.publish == true` (a missing input evaluates to not-publish); invariant test                  |

---

## 9. Implementation steps by milestone

General rules for every milestone:

- Cut a branch `ci/speedup-m<N>-<topic>` from `main` (no worktrees). Get user approval before each
  commit and push. Open a **draft** PR against `main` with
  `gh pr create --repo youpele52/bigbud --draft --base main` (no Claude attribution in commits or the
  PR body). Validate it with the PR's real CI run, and record the run IDs and timings in the PR
  body. The user merges. Then bring `main` back into `dev` using the user's usual flow (OQ-5).
- Keep every new or edited code file at 400 lines or fewer. Workflow YAML is not subject to the
  limit, but keep composite actions small.
- Focused checks only (section 10). Never run `bun test`. Ask before any repository-wide check.

### M1. Hygiene with no change to the job graph

Goal: lower risk and add caching while keeping today's behaviour and timings. This milestone covers
timeouts, concurrency, cache policy and pins.

1. **`.github/actions/setup-bigbud/action.yml` (new composite).** Steps: `oven-sh/setup-bun@<sha>`
   (`bun-version-file: package.json`), `actions/setup-node@<sha>` (`node-version-file: package.json`),
   restore the Bun cache (`actions/cache/restore@<sha>`, path `~/.bun/install/cache`, key
   `${{ runner.os }}-bun-${{ hashFiles('bun.lock') }}`, restore-keys `${{ runner.os }}-bun-`).
   Then resolve the Electron version. Electron is a `dependencies` entry of `apps/desktop`
   (`"electron": "40.6.0"`), not a devDependency. Read the installed package rather than the
   manifest:
   `node -p "require(require.resolve('electron/package.json', { paths: ['apps/desktop'] })).version"`.
   The step fails if the output is empty or `undefined`. Because the lookup needs `node_modules`, run
   it after install; see the ordering note below. Export `electron_config_cache` and `ELECTRON_CACHE`
   as `${{ runner.temp }}/electron-cache` through `$GITHUB_ENV`, and restore that path with key
   `electron-${{ runner.os }}-${{ runner.arch }}-<version>`. In every `actions/cache` `path:` input,
   write the expression `${{ runner.temp }}/electron-cache`, never `$RUNNER_TEMP` (the cache action
   does not expand shell variables).

   Ordering note: the Electron download happens in the `electron` postinstall during install. So the
   cache must be restored **before** install, using a key the action can compute before install.
   Compute the version before install from `bun.lock` (the `"electron@<version>"` entry) with a small
   `node -e` that reads only the lockfile. After install, assert that it equals the installed
   version from the `require.resolve` lookup above, and fail on a mismatch or an empty value.
   Install with `node scripts/bun-install-with-retry.ts` (input `install: full`, the default) or
   `bun install --frozen-lockfile --ignore-scripts` (`install: ignore-scripts`). Finally,
   conditional `actions/cache/save@<sha>` steps for both caches, run only when input
   `save-caches == 'true'`, `github.event_name == 'push'`, `github.ref == 'refs/heads/main'` and the
   primary key missed. Linux only (OpenCode measured cache extraction to be slower on Windows).

2. **`ci.yml` `quality` job:** replace its setup, cache and install steps with `setup-bigbud`
   (`save-caches: 'true'`). This drops `.turbo` from the cached paths and `turbo.json` from the key
   (D-6). Add a Playwright cache around the existing install step:
   `actions/cache/restore` of `~/.cache/ms-playwright`, key
   `playwright-${{ runner.os }}-${{ runner.arch }}-<version>`, where the version is resolved from
   `apps/server` with `node -p "require(require.resolve('playwright/package.json', { paths: ['apps/server'] })).version"`.
   Keep `bun run --cwd apps/server test:browser:install` (it skips the download on a hit and still
   installs system dependencies). Add a main-only save.
3. **`ci.yml` `desktop_release_build`:** add Electron cache restore/save around the build. All four
   targets build for the runner's own architecture, so a key with `runner.os` + `runner.arch` is
   correct. Save only on a `main` push (the job already runs only then).
4. **`ci.yml` `concurrency`** as in 7.1, and a `workflow_dispatch:` trigger.
5. **`timeout-minutes`** on every job in `ci.yml`, `release.yml`, `release-desktop-build.yml`
   (`build`: 90 for notarisation headroom), `release-remote-agent-build.yml` (30) and
   `release-remote-backend-graph.yml` (30). Do **not** add `concurrency` to the reusable workflows
   (I-5). Explicit M1 values for jobs whose final value comes later:

   | Job                       | M1 value | Later value                               |
   | ------------------------- | -------- | ----------------------------------------- |
   | `ci.yml` `quality`        | 150      | job removed in M3                         |
   | `release.yml` `preflight` | 120      | 15 in M4 (once it only resolves metadata) |
   | `release.yml` `release`   | 30       | 30                                        |

   The other existing jobs use the 7.1/7.2 values (about 2× their p90). The M1 invariant test only
   checks that every non-reusable job **has** a numeric `timeout-minutes`, not the M4 values.

6. **Pin every action** in the five workflows and both composites to a commit SHA with a trailing
   comment naming the ref that was actually resolved (for example `# v6` or `# stable`). Write
   `# v6.0.1` only if that exact patch tag was resolved and points at the same SHA. Resolve each one
   at implementation time
   (`git ls-remote https://github.com/<owner>/<repo> 'refs/tags/<tag>^{}' 'refs/tags/<tag>'`, or for
   `dtolnay/rust-toolchain` the `stable` branch head). Reference SHAs resolved on 2026-11-20 (re-check
   them; do not copy blindly):

   | Action                                  | Ref    | SHA (2026-11-20)                           |
   | --------------------------------------- | ------ | ------------------------------------------ |
   | `actions/checkout`                      | v6     | `d23441a48e516b6c34aea4fa41551a30e30af803` |
   | `oven-sh/setup-bun`                     | v2     | `0c5077e51419868618aeaa5fe8019c62421857d6` |
   | `actions/setup-node`                    | v6     | `249970729cb0ef3589644e2896645e5dc5ba9c38` |
   | `dtolnay/rust-toolchain`                | stable | `39008827e6b4319a349e9a42dfc90579dd25f1ca` |
   | `actions/cache` (+ `/restore`, `/save`) | v5     | `caa296126883cff596d87d8935842f9db880ef25` |
   | `actions/upload-artifact`               | v4     | `ea165f8d65b6e75b540449e92b4886f43607fa02` |
   | `actions/download-artifact`             | v4     | `d3f86a106a0bac45b974a628896c90dbdf5c8093` |
   | `softprops/action-gh-release`           | v2     | `3bb12739c298aeb8a4eeaf626c5b8d85266b0e65` |
   | `docker/setup-qemu-action`              | v3     | `c7c53464625b32c7a7e944ae62b3e17d2b600130` |
   | `apple-actions/import-codesign-certs`   | v2     | `8f3fb608891dd2244cdab3d69cd68c0d37a7fe93` |

   Every `dtolnay/rust-toolchain` use already passes `toolchain: 1.95.0` (13 of 13), which a SHA pin
   requires.

7. **Workflow invariant tests (new):** `apps/server/scripts/ciWorkflowInvariants.test.ts` (generic
   checks: pins, timeouts, concurrency, cache-save guards for the five workflows and the composites),
   following the `yaml` parsing pattern of `releaseAssetWorkflows.test.ts`. New files fall into the
   serial `integration` project by default. Optionally probe it into `unit` with
   `bun run --cwd apps/server test:groups scripts/ciWorkflowInvariants.test.ts`.

Validation (draft PR):

- CI run green. Total time roughly at baseline (±10%).
- Logs show the cache save steps **skipped** on the PR, the Playwright and Electron restore steps
  run, and every job shows its timeout in the job's setup output.
- After merge, the first `main` run saves the Bun, Electron and Playwright caches (cache list via
  `gh api repos/youpele52/bigbud/actions/caches`). The next PR run gets cache hits, and its Electron
  postinstall does not download.

Rollback: `git revert` the M1 merge commit on `main` (with approval). The caches stay harmless and
expire after 7 days unused.

### M2. Parallel jobs and server shards in shadow mode

Goal: run the new job graph next to the unchanged monolith, so shard correctness and timing are
proven on real runs **before** anything relies on them.

1. **Bun scripts (source of truth):**
   - `package.json`: `"test:packages": "turbo run test --filter=!@bigbud/server"` and
     `"test:server": "turbo run test --filter=@bigbud/server --"`. The trailing `--` means
     `bun run test:server --project=integration --shard=1/8` forwards the Vitest arguments through
     Turbo, which keeps `^build` and strict env (2.3 item 3).
   - `apps/server/package.json`: `"test:list-files": "vitest list --filesOnly"`.
   - `justfile`: `test-packages`, `test-server`, `server-test-list-files` (thin `"$@"` wrappers in
     the existing style).
   - Root `package.json` CI helpers: `"ci:verify-shard-coverage": "node scripts/verify-test-shard-coverage.ts"`
     (M2) and `"ci:wait-for-verdict": "node scripts/wait-for-ci-verdict.ts"` (M4), with just recipes
     `ci-verify-shard-coverage` and `ci-wait-for-verdict`. CI may still call `node scripts/…`
     directly, because the `ci_gate` job has no `bun install`. The Bun script is the documented entry
     point, and the invariant test asserts that both point to the same file.
   - `docs/COMMANDS.md`: rows for every new script and recipe in "Root: checks, tests, and cleanup"
     and "Workspace: apps/server", plus a short note that the `ci:*` scripts are meant for CI and
     local debugging of its reports.
2. **`.github/actions/setup-rust-native/action.yml` (new composite):** `dtolnay/rust-toolchain@<sha>`
   with `toolchain: 1.95.0` and a `components` input, then
   `sudo apt-get update && sudo apt-get install --yes protobuf-compiler`. Linux only.
3. **New jobs in `ci.yml`** (all `needs`-free, with timeouts from 7.1):
   - `fmt_lint`: `setup-bigbud` (`save-caches: 'true'`, this job becomes the designated cache
     writer), `bun run fmt:check`, `bun run lint`. While `quality` still exists (M2), both jobs may
     try to save the same key. The second save only logs a "cache already exists" warning. In M3,
     `quality` and its save go away.
   - `typecheck`: `setup-bigbud`, `bun run typecheck`.
   - `rust`: `setup-rust-native` (`components: rustfmt, clippy`), `cargo fmt --all --check`,
     `cargo clippy --locked --workspace --all-targets -- -D warnings`, `cargo test --locked --workspace`,
     `cargo build --locked --workspace --release`.
   - `build_desktop_pipeline`: `setup-bigbud`, `setup-rust-native`, `bun run build:desktop`, then the
     existing preload check. Rust is required: the `@bigbud/server` build runs two
     `cargo build --release` commands (section 2.3 item 5). Cold estimate 5–7 min. The invariant test
     asserts that this job uses `setup-rust-native`.
   - `test_packages`: `setup-bigbud`, `setup-rust-native`, then
     `cargo test --locked --workspace --no-run` (step name "Prepare native test binaries"). This
     builds exactly the debug binary set the monolith had, because `cargo test` builds the bins of
     packages with integration tests (I-8). Then `bun run test:packages`.
   - Report directory: every test job first runs `mkdir -p "$RUNNER_TEMP/server-test-reports"` so
     the JSON reporter never depends on Vitest creating parent directories.
   - `test_server_unit`: `setup-bigbud`, then
     `bun run test:server --project=unit --reporter=default --reporter=json --outputFile.json="$RUNNER_TEMP/server-test-reports/unit.json"`.
     Upload the report as artifact `server-test-report-unit` (`if: always()`, `retention-days: 7`).
     Unit files are guard-checked not to spawn processes, so no Rust or Playwright is needed.
   - `test_server_integration`: `strategy: { fail-fast: false, matrix: { shard: [1, 2, 3, 4, 5, 6, 7, 8] } }`;
     `setup-bigbud`, `setup-rust-native`, `cargo test --locked --workspace --no-run`, Playwright cache
     restore + `bun run --cwd apps/server test:browser:install` (shard 1 saves the cache on `main`),
     then
     `bun run test:server --project=integration --shard=${{ matrix.shard }}/${{ strategy.job-total }} --reporter=default --reporter=json --outputFile.json="$RUNNER_TEMP/server-test-reports/integration-${{ matrix.shard }}.json"`.
     Upload `server-test-report-integration-${{ matrix.shard }}` (`if: always()`, `retention-days: 7`,
     `overwrite: true`). Use `overwrite: true` on the unit report upload too: `upload-artifact@v4`
     rejects a second upload with the same name in the same run, which would break "Re-run failed
     jobs" for a single shard.
   - `test_server_shard_coverage`: `needs: [test_server_unit, test_server_integration]`,
     `if: ${{ !cancelled() }}`. Run `setup-bigbud`, then download the reports with
     `pattern: server-test-report-*`, `merge-multiple: true`,
     `path: ${{ runner.temp }}/server-test-reports` (one flat directory),
     `bun run --cwd apps/server test:list-files --json="$RUNNER_TEMP/expected.json"`, then
     `bun run ci:verify-shard-coverage …` with `--shard-count 8`. Keep the shard count in one
     place: matrix length and `--shard-count` must match (invariant test).
4. **Coverage script:** a pure module `scripts/lib/test-shard-coverage.ts` (parse, normalise, diff,
   totals), its tests in `scripts/lib/test-shard-coverage.test.ts` (cases: exact cover passes; missing file;
   duplicate across shards; unexpected file; unit file in a shard; missing shard report; skipped-only
   file counted; path normalisation across different roots) + entry
   `scripts/verify-test-shard-coverage.ts` (argument parsing, file IO, step summary, exit code).
   Node built-ins only; erasable TypeScript syntax like the existing `scripts/*.ts`.
5. **Keep `quality` unchanged** (shadow baseline). It is still the only gate desktop builds depend on.

Shard verification (answers Q1 before anything relies on it; see section 10.2 for the procedure).

Validation (draft PR): at least 3 green runs of the PR (push plus 2× "Re-run all jobs"), 1
perturbation run with the matrix temporarily at `[1..6]` and `--shard-count 6` (reverted before
merge), and 1 single-shard re-run: use "Re-run job" on one `test_server_integration` shard, then on
the coverage job. Confirm the re-uploaded report replaces the old one and the coverage check still
passes.
Record per run the slowest shard, `test_packages`, `typecheck`, the queue delay (job `started_at`
minus run start), and the coverage totals compared with the `quality` job's summary lines
(`Test Files … passed | … skipped`, `Tests … passed | … skipped | … todo`) for every package.
Merge only when coverage passes on every run and totals match, or every difference is explained
(for example a file that is skipped in both).

After merge: keep shadow mode for at least 3 `main` pushes and compare again.

Rollback: revert the M2 commit. The monolith is untouched, so behaviour returns to M1.

### M3. Cut over: remove the monolith, add `CI passed`, start builds immediately

1. Delete the `quality` job from `ci.yml`.
2. Add `ci_passed` (7.1): `if: always()`, `needs` = every verification job, including
   `test_server_shard_coverage`, `release_smoke`, the Windows smokes, `windows_cua_sweep`, both
   native cleanup jobs, `fmt_lint`, `typecheck`, `rust`, `build_desktop_pipeline`, `test_packages`,
   `test_server_unit` and `test_server_integration`. Step: `env: NEEDS: ${{ toJSON(needs) }}`, then
   `jq -e --argjson n <expected count> 'length == $n and all(.[]; .result == "success")'` (or compare
   `keys` with the expected job-ID list), with a per-job table written to the step summary. A plain
   `all()` is vacuously true on an empty object.
3. Remove `needs` from `desktop_release_build`, `workspace_agent_windows_arm64` and
   `workspace_agent_linux_arm64` (I-9). Keep their `if:` text identical to `release_asset_assembly`'s
   `if:` (required by `releaseAssetWorkflows.test.ts`).
4. `release_asset_assembly.needs`: `[ci_passed, desktop_release_build, workspace_agent_windows_arm64, workspace_agent_linux_arm64]`
   (`release_smoke` is now covered by `ci_passed`).
5. Extend `ciWorkflowInvariants.test.ts`: `ci_passed` exists with `if: always()` and its needs
   include every job that has no `if:` plus `test_server_shard_coverage`; the expected count in the
   `jq` step equals `ci_passed.needs.length`; no needed job (or any of its steps) sets
   `continue-on-error`; main-only build jobs have no `needs`; assembly needs `ci_passed`; matrix
   length equals `--shard-count`; `build_desktop_pipeline` uses `setup-rust-native`.

Validation: PR run with `CI passed` ≤ 20 min. Then 3 consecutive `main` runs: verdict ≤ 20 min
(median) and full run ≤ 30 min (median). For every run, record the queue delay per job (`started_at`
minus run `created_at`) and the peak macOS queue. Include one back-to-back case (two `main` pushes
less than 10 min apart, both allowed to finish) and record how much the second verdict slips. If
the slowest shard is above 15 min at the median, apply the tuning levers in section 11 (R-2) before
M4.

Rollback: revert M3, which restores the M2 shadow state with the monolith. Once M4 has landed, M4
depends on M3's `CI passed` job (the gate looks for it). Revert M4 first, or revert both in one
change; never revert M3 alone after M4.

### M4. Release: slim preflight, CI gate, publish-only waiting

1. **Gate script:** `scripts/lib/ci-verdict.ts` (pure decision function and response-shape parsing;
   no workspace imports) + `scripts/lib/ci-verdict.test.ts`. Cases: pass on `CI passed` success;
   ignore `pull_request` runs; ignore runs from another repository; run success without a
   `CI passed` job does not pass; in-progress means wait; completed failure means fail; no run means
   wait until the grace period, then fail with the dispatch hint; any passing candidate among
   several wins; latest attempt only; deadline; API errors are never a pass. Entry
   `scripts/wait-for-ci-verdict.ts`: argument parsing, bounded `fetch` with timeouts and retries,
   polling loop, step summary.
2. **`release.yml`:**
   - Top-level `permissions: contents: read`.
   - `workflow_dispatch.inputs.publish`: boolean, default `false`, description "Publish the GitHub
     release (otherwise a dry run that builds and verifies only)" (OQ-2, decided).
   - Dry-run artifact retention: when `github.event_name == 'workflow_dispatch' && inputs.publish != true`,
     the release build artifacts are signed but unpublished in a public repository. Upload them with
     `retention-days: 3`. Pass a `retention_days` input to the reusable workflows (default unchanged
     for tag runs) and use it in their `upload-artifact` steps, keeping the existing step shape that
     the tests assert.
   - `preflight`: keep the checkout, Bun and Node setup and the `release_meta` step. Install with
     `bun install --frozen-lockfile --ignore-scripts` (metadata needs only `@bigbud/shared`). Remove
     the Rust setup, protoc, and the fmt, lint, typecheck, Rust, Playwright and Test steps. Keep the
     job ID and name `Preflight`.
   - New `ci_gate` (7.2/7.3): checkout (`ref: ${{ needs.preflight.outputs.ref }}`,
     `persist-credentials: false`), setup-node, an assertion step
     (`test "$(git rev-parse HEAD)" = "${{ needs.preflight.outputs.ref }}"`), then
     `node scripts/wait-for-ci-verdict.ts --repo "$GITHUB_REPOSITORY" --sha "${{ needs.preflight.outputs.ref }}" --workflow ci.yml --job "CI passed"`
     with `GITHUB_TOKEN: ${{ github.token }}`. No secrets.
   - `build.needs: [preflight]`.
   - `release`: add `ci_gate`, `native_resource_cleanup` and `native_resource_cleanup_mount` to
     `needs`; set `if: ${{ github.event_name == 'push' || inputs.publish == true }}` and
     `permissions: contents: write`. Keep everything else, including the job key `release` and the
     `bun install --frozen-lockfile --ignore-scripts` step (release-smoke).
3. Extend the invariant tests (a separate `ciWorkflowInvariants.release.test.ts` if the file nears
   400 lines): `release.needs ⊇ {ci_gate, every build job, both cleanup jobs}`;
   `build.needs == ['preflight']`; `preflight` has no `bun run test`, `typecheck` or `cargo` step;
   `ci_gate` has no `secrets.` reference and has `actions: read`; only `build`,
   `remote_backend_graph_build` and `release` reference secrets; the publish `if` matches I-10;
   there is no `concurrency` key.
4. `docs/COMMANDS.md`: document `bun run ci:wait-for-verdict` (and the direct `node` form the gate
   uses), and add a short release runbook note: tag a commit after its `main` CI shows `CI passed`. For other
   commits, run `gh workflow run ci.yml --repo youpele52/bigbud --ref <ref>` first.

Validation (draft PR, then one live signed and notarised dry run; approved by the user, OQ-2):

- PR CI green (covers `release_smoke`, the workflow tests and the new unit tests).
- `gh workflow run ci.yml --repo youpele52/bigbud --ref ci/speedup-m4-release-gate`, then wait for
  `CI passed`.
- **Safety preconditions (mandatory).** Today a `release.yml` dispatch **always publishes**
  (`release.yml` lines 7–12 and 245–399 have no publish guard). So before dispatching:
  1. `gh workflow view release.yml --repo youpele52/bigbud --ref ci/speedup-m4-release-gate --yaml | grep -q 'publish:'`
     must succeed. This proves the branch's workflow has the guarded input; abort otherwise.
  2. Confirm the branch's `release` job `if:` is
     `github.event_name == 'push' || inputs.publish == true`.
  3. Use a version that cannot collide with a real release and that `resolveReleaseVersion`
     (`packages/shared/src/releaseChannel.ts`) accepts. The channel must be `beta|preview|nightly`,
     so `0.0.0-dryrun.<n>` is **rejected**. Use `0.0.0-preview.dryrun.<n>` (for example `<n>` =
     today's date and time).
- Dispatch with the input passed explicitly:
  `gh workflow run release.yml --repo youpele52/bigbud --ref ci/speedup-m4-release-gate -f version=0.0.0-preview.dryrun.<n> -f publish=false`.
  Expected: builds start ≤ 3 min after run start; `ci_gate` passes within 1 min (CI already green);
  every build job succeeds; `Publish GitHub Release` is **skipped**; no tag or release exists
  (`gh release view v0.0.0-preview.dryrun.<n> --repo youpele52/bigbud` must fail); the uploaded
  artifacts show the short retention. Measure the wall time to the last build job. If anything
  suggests publish might run, cancel the run immediately. (Cancelling a dry run is allowed; I-5
  covers tag runs.)
- Negative check (same preconditions and `-f publish=false`): dispatch the dry run on a commit with no CI run (for example a throwaway commit on
  the branch pushed with CI not dispatched). `ci_gate` must fail after the 10-minute grace period and
  publish must be skipped. If the user prefers, the unit tests can cover this instead.
- After merge: the next real tag measures the full wall time (AC-3).

Rollback: revert M4 on `main` (before or together with any M3 revert). A tag always runs the `release.yml` stored in its own commit, so tags
on commits before the revert keep the M4 behaviour. If the gate misbehaves during a real release,
qualify the commit with a `ci.yml` dispatch and re-run the failed jobs. If the gate code itself is
wrong, revert M4 and tag the next version on the reverted commit.

### M5. Required `CI passed` check via a ruleset (user decided: yes)

The user wants `CI passed` to be a required check. Work currently lands by direct pushes and squash
merges to `main`, and a required status check would block direct pushes. The plan:

1. Precondition: M3 is on `main` and `CI passed` has reported on at least 3 `main` runs, so the
   check name exists and is stable.
2. Create a repository ruleset targeting `main` (default branch) with the rule "Require status
   checks to pass", check `CI passed` (source: GitHub Actions). Add the repository admin role (the
   owner account) to the **bypass list** with mode "always", so the owner's direct pushes and squash
   merges keep working. Pull requests from anyone else must have a green `CI passed`. Do not enable
   "require branches to be up to date" (it would force extra CI runs) unless the user asks.
3. This is a repository setting, not a file change. Prepare the exact payload
   (`gh api --method POST repos/youpele52/bigbud/rulesets` with the JSON) and get the user's explicit
   approval at that time before applying it. Verify with `gh api repos/youpele52/bigbud/rulesets`
   and one test PR showing the required check.
4. Alternative (not chosen now): land everything through PRs with no bypass. This gives stronger
   enforcement, but it changes the user's workflow.
5. Rollback: disable or delete the ruleset (again with approval). No file changes.

---

## 10. Validation plan

### 10.1 Focused local checks (per milestone, for changed files only)

```sh
# Formatting: always pass explicit, non-empty file lists (oxfmt with no paths formats the repo).
bunx oxfmt --check .github/workflows/ci.yml .github/workflows/release.yml <other changed files>
bunx oxlint <changed .ts files>
wc -l <changed code files>        # each must be ≤ 400

# Unit tests for new scripts (scripts package; Vitest root is scripts/)
bun run --cwd scripts vitest run lib/test-shard-coverage.test.ts lib/ci-verdict.test.ts

# Workflow assertion tests
bun run --cwd apps/server vitest run scripts/releaseAssetWorkflows.test.ts \
  scripts/releaseAssetWorkflows.notices.test.ts scripts/ciWorkflowInvariants.test.ts

# Release smoke (reads workflow text; uses a temp dir outside the repo)
node scripts/release-smoke.ts

# Package typechecks for touched packages (ask approval first if your session treats them as broad)
bun run --cwd scripts typecheck
bun run --cwd apps/server typecheck
```

Optional: `actionlint` (rhysd/actionlint), run from a binary outside the repository, on the changed
workflows. Do not add it to the repository in this plan.

Check before M2 (read-only): confirm the Turbo selection with
`bunx turbo run test --filter='!@bigbud/server' --dry=json` from the repository root. The task list
must contain `test` for exactly `@bigbud/web`, `@bigbud/desktop`, `@bigbud/mobile-web`,
`@bigbud/contracts`, `@bigbud/shared`, `@bigbud/ui` and `@bigbud/scripts` (plus their `^build`
tasks). If it does not, replace the negation with explicit `--filter` arguments and add an invariant
test that compares them with the packages that have a `test` script.

### 10.2 Shard verification procedure (Q1), required before M3

1. **Static (done in planning, repeat at implementation):** `bun run --cwd apps/server test:list-files --json=/tmp/bigbud-shards/expected.json`.
   Then run an offline re-implementation of `BaseSequencer.shard` (SHA-1 of `/<path relative to apps/server>`,
   sorted, contiguous `calculateShardRange` slices) as a throwaway script under `/tmp`, not in the
   repository. Confirm that the union of the 8 slices equals the integration list with no overlap.
2. **Authoritative (M2 CI):** `test_server_shard_coverage` compares each shard's JSON report (the
   files that actually ran) with `vitest list --filesOnly`. It must pass on all 3 shadow runs, the
   perturbation run and 3 `main` shadow runs.
3. **Equivalence (M2 CI):** coverage totals equal the monolith's server totals in the same run
   (2,389 files and 11,889 tests at baseline; expect small drift as tests are added).
4. **Order-dependence probe:** the 6-shard perturbation run gives each file different neighbours. A
   file that fails only under some shard layout is an order dependency; see R-1.

**Fallback ladder if step 2 or 3 fails:**

- **F1 (selection wrong):** stop relying on built-in `--shard`. Add a custom
  `sequence.sequencer` in `apps/server/vitest.config.ts`
  (`apps/server/scripts/serverTestShards.sequencer.ts`, extending Vitest's `BaseSequencer` and
  overriding only `shard()`). It should do the same explicit hash partition over the files it
  receives. The coverage check stays as the guard.
- **F2 (shards unstable):** run `test_server_integration` as a single unsharded job
  (`bun run test:server --project=integration`), keeping the rest of the split. That is correct, but
  CI stays at about 65 min until the order-dependent files are fixed in separate tasks. Do not add
  retries.

### 10.3 Evidence of completion

PR descriptions (or the milestone notes) record run IDs and links, per-job durations, queue delays,
coverage totals versus the monolith, cache hit/miss/save lines, and the M4 dry-run outcome
(publish skipped, no release created).

---

## 11. Risks and mitigations

| ID   | Risk                                                                                                                                                                                                                                                                                                                                          | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1  | Order-dependent tests surface when a file's neighbours change (leftover temp files, env, global state across serial files)                                                                                                                                                                                                                    | Shadow runs + perturbation run; reproduce locally with `bun run test:server --project=integration --shard=i/N` and fix the test (isolate state). No blanket retries. F2 fallback if a fix is not quick. Runners are separate VMs, so there is no cross-shard collision (research Q3).                                                                                                                                                                           |
| R-2  | The slowest shard misses the target (per-shard overhead: setup about 1.5 min, `cargo test --no-run` about 2, `^build` about 3, Playwright apt 0.3–5.5)                                                                                                                                                                                        | Tuning levers in order: (a) 10 shards; (b) run the Rust prep and `turbo run build --filter=@bigbud/server^...` concurrently in one step with explicit exit-status handling; (c) Playwright `install-deps` only when `ldd` reports missing libraries; (d) a Rust target cache restored from `main` (new third-party action, needs approval).                                                                                                                     |
| R-3  | GitHub concurrency limits (20 jobs, 5 macOS, per account) cause queueing, especially when a tag is pushed while `main` CI runs                                                                                                                                                                                                                | Budget in 7.1/7.2; tag after `CI passed` (runbook); most queued jobs are ≤ 2 min; the release gate stays correct while waiting. Possible later consolidation of the tiny Windows smoke jobs.                                                                                                                                                                                                                                                                    |
| R-4  | Flaky tests block the verdict and therefore releases                                                                                                                                                                                                                                                                                          | Sharding makes re-runs cheap ("Re-run failed jobs" re-runs one shard, about 15 min, instead of 81). The gate can be re-run after CI is re-run. Quarantine (C11) is a follow-up; no retries in blocking legs.                                                                                                                                                                                                                                                    |
| R-5  | Silent coverage loss from a missing native binary, Playwright or env difference                                                                                                                                                                                                                                                               | I-8 (same prerequisites), M2 totals comparison including skipped counts, and the coverage check on every run.                                                                                                                                                                                                                                                                                                                                                   |
| R-6  | The release gate passes the wrong thing (PR merge-commit run, fork run, stale attempt)                                                                                                                                                                                                                                                        | Event/repository filters, latest attempt only, the job named exactly `CI passed`, unit tests, and an invariant test that `ci_passed` requires all-success.                                                                                                                                                                                                                                                                                                      |
| R-7  | Builds now sign and notarise commits before tests are known to pass; unpublished signed artifacts remain as run artifacts (public repository). The release-signed backend graph path (`release_signing: true`, pinned key, dirty-tree provenance check) is never exercised by CI, which signs with a fixture key; beta.1 failed exactly there | Nothing is published without the gate. Dry-run dispatches upload with `retention-days: 3` (M4). With builds no longer behind a serial preflight, a release-only failure such as beta.1's graph or Apple-agreement failure surfaces within about 2–8 min of the tag instead of about 60. A CI leg for the release-signed graph is a follow-up, because it needs the release key, which must not reach CI. Apple notarisation of an unreleased build is harmless. |
| R-8  | Main macOS x64 Intel preview build (12–24 min) or release macOS x64 build (up to 26 min) keeps the full main run or the release above target. Release-only paths (signed graph, signing, notarisation) can still fail after CI passed                                                                                                         | Verdict excludes preview builds; release ≈ 17–31 min. If AC-3 is missed in 2 of 3 releases, start research C1 (build x64 on arm64 + an x64 smoke) as a separate plan. Release-only failures are not caught by the gate. They fail the run before publish, and the fix-and-retag cycle is now about 30 min instead of about 85.                                                                                                                                  |
| R-9  | Cache poisoning or eviction                                                                                                                                                                                                                                                                                                                   | Saves only from `main`; release workflows restore nothing; keys are versioned; 10 GB budget (1.2 GB used today plus about 0.3 GB Electron per OS/arch and about 0.2 GB Playwright).                                                                                                                                                                                                                                                                             |
| R-10 | SHA pins go stale                                                                                                                                                                                                                                                                                                                             | Version comments on each pin. Dependabot for `github-actions` is a follow-up (user decision).                                                                                                                                                                                                                                                                                                                                                                   |
| R-11 | Workflow-structure tests break on refactors                                                                                                                                                                                                                                                                                                   | Keep job IDs `workspace_agent_*`, `native_resource_cleanup`, `release`, `release_asset_assembly`, the `if:` equality and the `release-smoke.ts` strings; run those tests locally before every push.                                                                                                                                                                                                                                                             |

Rollout order and rollback are per milestone (section 9). Observability: the step summaries of
`ci_passed`, the coverage check and the gate, plus `gh run view --json jobs` timings.

---

## 12. Acceptance criteria

| ID   | Criterion                                                                                                                                                                                                 | Measured by                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| AC-1 | PR CI: `CI passed` completes ≤ 20 min after run start (median of 3 consecutive green runs), with no run above 25 min                                                                                      | `gh run view <id> --repo youpele52/bigbud --json jobs`                       |
| AC-2 | `main` CI: verdict ≤ 20 min median over 3 consecutive green pushes; the full run including preview builds and assembly ≤ 30 min median                                                                    | same                                                                         |
| AC-3 | Release for a tag on a commit that already passed CI: desktop builds start ≤ 3 min after run start; total wall ≤ 32 min, and ≤ 30 min in at least 2 of the first 3 releases (macOS x64 Intel caveat, R-8) | release run timings                                                          |
| AC-4 | Publish runs only after `ci_gate` succeeded; a dispatch without `publish: true` skips publish; a commit with no passing CI fails the gate                                                                 | M4 dry run, negative check, unit tests                                       |
| AC-5 | The shard coverage check passes on every run; no file is missing or duplicated; shadow totals equal the monolith's or every difference is explained                                                       | coverage step summary versus `quality` logs                                  |
| AC-6 | All invariant tests pass: SHA pins, timeouts on every non-reusable job, no cancellation for `main`/dispatch/release, cache saves only from `main` pushes, the secrets scope                               | `bun run --cwd apps/server vitest run scripts/ciWorkflowInvariants*.test.ts` |
| AC-7 | Caches: PR runs execute no save step; `main` runs save; a later run reports hits for Bun, Electron and Playwright                                                                                         | job logs, `gh api repos/youpele52/bigbud/actions/caches`                     |
| AC-8 | No coverage regression: every job and check from section 6 still runs (job inventory diff) and `release_smoke` passes                                                                                     | workflow diff review + CI                                                    |

---

## 13. Decisions on the former open questions (answered by the user, 2026-11-20)

All questions are answered; none is open.

- **OQ-1 (decided). Release gate mode:** the release waits for `CI passed` on the exact tagged SHA
  (`push` or `workflow_dispatch` CI runs only), as described in 7.3. Rejected alternative: calling
  the CI tests as a reusable workflow inside the release, which would add about 26 jobs to a 19-job
  release.
- **OQ-2 (decided). Dispatch semantics:** manual `release.yml` dispatches are dry runs unless
  `publish: true` (new input, default `false`). The user approved one signed and notarised dry run
  from the M4 branch, using the safety preconditions in M4.
- **OQ-3 (decided). Desktop preview builds:** they stay on every `main` push, start immediately, and
  are excluded from the `CI passed` verdict.
- **OQ-4 (decided). Required check:** yes. Implemented as M5: a ruleset on `main` requiring
  `CI passed`, with the repository admin (the owner account) on the bypass list so direct pushes and
  squash merges keep working. Ruleset changes are repository settings, applied only with the
  user's explicit approval at that time. The alternative, PR-only landing without bypass, is recorded
  but not chosen.
- **OQ-5 (default stands).** Landing flow: milestone branches cut from `main`, draft PRs to `main`,
  the user squash-merges, then `main` is merged back into `dev`.
- **OQ-6 (default stands).** Web and mobile-web `test:browser` suites stay out of CI in this plan.
- **OQ-7 (default stands).** Start at 8 shards; move to 10 if the slowest shard's median is above
  15 min.

---

## 14. Plan validity

- Describes `dev` @ `6f7246e463` / `6a09f0c95d` and `main` @ `7c610f7923`. The pipeline files
  (`.github/workflows/*`, `turbo.json`, `package.json`, `apps/server/package.json`,
  `apps/server/vitest.config.ts`, `scripts/release-smoke.ts`, the workflow tests, `justfile`,
  `docs/COMMANDS.md`) are identical on both branches.
- Worktree during planning: untracked `docs/reports/2026-11-20-*.md` at the start. Later, someone
  else's uncommitted app changes appeared (desktop, web, shared and `crates/bigbud-remote-agent`
  files). None of them is a pipeline file. This plan created only this file.
- External facts: GitHub limits (A1) read 2026-11-20; action SHAs resolved 2026-11-20; Vitest 4.1.5
  shard internals; Turbo 2.11.5 docs from `node_modules/turbo/docs`.
- **Revalidate if:** Vitest or Turbo is upgraded (re-read shard/list behaviour and env mode); any
  job is added to or removed from `ci.yml`/`release.yml`; the server test grouping changes; a test
  starts depending on a new native binary or tool; GitHub changes the free-tier limits; the
  integration file count grows by more than 25% (re-check shard count); or the user changes how
  releases are tagged (OQ-1, A3).

---

## 15. Handoff notes

**Implementation order:** M1 → M2 (shadow) → M3 (cut-over) → M4 (release) → M5 (ruleset, with
explicit user approval when applied). Do not start M3 before the M2 shadow evidence (10.2) is
complete. Do not start M5 before `CI passed` has reported on at least 3 `main` runs. Rollbacks go in
reverse order: M4 before or together with M3.

**Settled decisions (do not reopen without new evidence):**

- D-1 Integration shards run through Turbo (`bun run test:server -- …` via the trailing `--`
  script) to keep `^build` and strict env.
- D-2 Test jobs rebuild native binaries with `cargo test --locked --workspace --no-run`, the same set
  as the monolith (not `cargo build`, which could enable tests that were skipped before).
- D-3 Every integration shard installs Playwright (from cache); browser tests stay inside the
  integration project.
- D-4 The coverage check (union of the JSON reports compared with `vitest list --filesOnly`) runs on
  every CI run and is part of `CI passed`.
- D-5 Desktop preview builds stay on every `main` push and are excluded from `CI passed` (OQ-3).
- D-10 The release gate waits for `CI passed` on the exact SHA (OQ-1). Dispatches are dry runs
  unless `publish: true` (OQ-2). `CI passed` becomes required through an M5 ruleset with owner
  bypass (OQ-4).
- D-11 `build_desktop_pipeline` installs Rust and protoc (the server build runs release cargo
  builds). Shard reports upload with `overwrite: true` and download with `merge-multiple: true`.
  `ci_passed` checks the need count as well as the results.
- D-6 Turbo `cache: false` for `test` and `typecheck` stays. Reason: there are no declared `inputs`
  or `globalDependencies` (root tsconfig, Vitest configs and env would not invalidate the cache), no
  remote cache, and immutable `actions/cache` keys. A cacheable design needs explicit inputs, a
  per-run cache key and an uncached audit (research C5). `.turbo` is dropped from the CI cache
  because it was frozen and gave nothing.
- D-7 No retries in blocking legs; no `fileParallelism` change; 8 shards to start.
- D-8 Release workflows restore no caches and carry no `concurrency` key.
- D-9 Least privilege in `release.yml`: top-level `contents: read`, `release` gets `contents: write`,
  `ci_gate` gets `actions: read`.

**Remaining blockers:** none. M1–M4 are ready. M5 needs the user's explicit approval at the time
the ruleset is applied.

**Review notes:** two planner review passes plus an independent plan-reviewer (verdict: ready with
fixes). All 15 reviewer findings are applied in this revision: Rust in `build_desktop_pipeline`;
Electron version lookup and cache path; explicit M1 timeouts; dry-run safety preconditions;
`overwrite: true` and a single-shard re-run test; overlapping-run concurrency; rollback coupling;
the beta.1 evidence; flat report download; the `ci_passed` count check and `continue-on-error`
assertion; `ci:*` Bun scripts; corrected job counts; the ownership-recovery test; pin comments; and
the gate HEAD assertion. One finding was refined rather than taken literally: the suggested dry-run
version `0.0.0-dryrun.<run>` is rejected by `resolveReleaseVersion`, so the plan uses
`0.0.0-preview.dryrun.<n>`.
