# Remote-agent residual corrections

**Date:** 8 September 2026
**Status:** Implemented locally; validation recorded; no release/push
**Owner:** `bigbud-github-action-debugger`
**Project root:** `/Users/youpele/DevWorld/bigbud`
**Baseline:** `main` at `545301f8eeadd22284b2c8e1730f7dd45197cb95`, plus the inherited dirty worktree
**Operating parameters:** target tag `none`; push `no`; no GitHub Actions, SSH/VPS, release, commit, tag, reset, clean, rebase, merge, or publish operations

## Clarified product goal

For each authenticated SSH account's canonical `~/.bigbud/agent` installation, keep at most two distinct remote-agent executable builds on disk. Prepare a compatible update automatically when capacity is safe, install and health-check its isolated runtime before it is eligible for reconnect, and leave the current stable runtime serving until the user deliberately reconnects. A deliberate reconnect may select the verified update for new work; existing work remains pinned to its original generation/epoch and route. If install or health verification fails, the most recent verified stable predecessor remains usable. Never interrupt active or uncertain work, write a third build, silently select a pending candidate, or duplicate a side effect after a lost reply or restart.

After `205 -> 207`, retain both `207` (current) and `205` (predecessor). For a later `208`, withdraw and retire `205` only after the production coordinator has proved that it is managed, idle, unreferenced, not selected by another controller, and safely shut down. Retirement must happen before any `208` bytes are written; `207` remains the fallback throughout. If any ownership, liveness, native shutdown, or physical inventory fact is uncertain, defer and preserve the old build.

## Scope

This corrective cycle is limited to four confirmed residuals in the existing TypeScript remote-agent update/retirement path and its focused tests:

1. Make released storage-slot reservations reusable while retaining unique reservation/replay/ownership evidence.
2. Reach safe predecessor withdrawal and fenced retirement from the real automatic preparation/install path, including active, uncertain, another-controller-selected, and safely idle cases.
3. Wire the actual release-source/configuration refresh path to the coordinator's existing coalesced source-change trigger, without credential prompts or arbitrary release-channel selection.
4. Tighten truthful Linux fixture-gated acceptance coverage for both supported architectures, legacy provenance, and physical on-disk counts.

Existing registry CAS, v2 state, physical inventory, retirement fence/native shutdown, automatic scheduler/coordinator, isolated health, deliberate admission, durable replay fence, owner bindings, and existing UI/RPC authorities remain the only authorities. No second scheduler, capacity owner, cleanup owner, or selector is introduced.

## Confirmed residual findings

The findings below were confirmed against the current dirty worktree before implementation.

### 1. Released slot IDs collide on reuse

`remoteAgentUpdate.state.ts` allocates the logical names `slot-0` and `slot-1`, and `releaseRemoteAgentSlot` changes a reservation to `released` but intentionally keeps its row. A later `reserveRemoteAgentUpdate` considers that slot free and appends another reservation with the same `id`. `parseRemoteAgentRegistry` validates all `slotReservations` in one collection and rejects duplicate IDs before the state can be published. Thus release evidence is retained, but the next candidate cannot reserve the reclaimed slot. The fix must separate stable slot identity from unique reservation identity; it must not delete or overwrite the released row.

### 2. Predecessor retirement is not reached by production preparation

`withdrawRemoteAgentPredecessor` and `reserveRemoteAgentRetirement(..., { withdrawPredecessor: true })` exist, and generic `cleanupRemoteAgentBuilds` can call `retireManagedRemoteAgentBuild`, but the real path is `RemoteAgentUpdateCoordinator -> prepareRemoteAgentCandidate -> installManager.install -> stageRemoteAgentBuild -> reserveRemoteAgentUpdate`. When physical inventory already contains current `207` and predecessor `205`, the capacity decision becomes `waiting-for-capacity`; no coordinator-side replacement reservation withdraws/ retires `205`, so `208` never reaches installation. Existing retirement rejects durable pins, stages, launches, and admissions and native control distinguishes live/dead/uncertain, but those guards are not connected to the replacement preparation transaction. The production path therefore needs a safe, idempotent pre-upload retirement attempt that leaves `207` protected and defers for active, uncertain, unknown-owned, or another-controller-selected `205`.

### 3. Source-change trigger has no production caller

The coordinator exposes `sourceChanged`, and its scheduler has `refreshNow()` that refreshes the process-scoped source cache and discovers targets with the `source-changed` trigger. Repository search found no production call to `sourceChanged`; current callers enqueue only after SSH verification/fresh admission, startup starts the scheduler, and the loader's `refresh` is otherwise invoked only by scheduler internals/tests. A source or release configuration change can therefore leave authenticated targets waiting for the periodic tick. The correction must connect the existing source/configuration change boundary to `sourceChanged` (or an equivalent coordinator trigger), preserve loader refresh and target coalescing, and never use it to prompt for credentials or choose an arbitrary release channel.

### 4. Linux acceptance coverage is truthful but incomplete

The latest Linux tests are gated by `BIGBUD_TEST_LINUX_DOCKER=1` and `BIGBUD_TEST_AGENT_FIXTURES`, and correctly skip when Docker/fixtures are unavailable. `remoteAgentUpgrade.production.linux.test.ts`, `remoteAgentUpgrade.legacy.linux.test.ts`, and related tests exercise source-built aarch64 legacy/candidate binaries and several legacy journal histories, but the current matrix does not establish x86_64 fixture provenance and does not assert physical executable counts at each update phase. The corrective tests must retain explicit environment-gated skips, add architecture-specific assertions only when the matching fixtures exist, retain fresh/unmatched/expired legacy provenance labels, and count actual files rather than treating registry rows as disk evidence. Unavailable Docker, fixtures, architecture binaries, or published-artifact trust must be recorded as skips/gaps, never fabricated as passes.

## Affected files and minimal changes

The exact final file set will be reported after implementation. The expected narrow set is:

- `apps/server/src/remote-agent/remoteAgentInstall.registry.ts` and `remoteAgentUpdate.state.ts`: add/derive a stable slot key distinct from unique reservation/replay IDs; keep backward parsing for existing v2 rows; allocate a fresh reservation ID on reuse; preserve all released evidence and CAS revisions.
- `apps/server/src/remote-agent/remoteAgentInstall.retirement.ts`, `remoteAgentInstall.cleanup.ts`, `remoteAgentUpdate.prepare.ts`, `remoteAgentUpdate.coordinator.ts`, and, if needed, a focused dotted helper: add the one production pre-upload capacity/replacement path. It must atomically reserve withdrawal, use the existing owner/reference and retirement fence/native shutdown path, verify deletion, then let the existing slot allocator proceed. It must not delete a predecessor merely because it is old or absent from one local snapshot.
- `apps/server/src/remote-agent/remoteAgentInstallSource.ts`, `remoteAgentServerLayer.ts`, or the existing configuration/settings boundary: expose one real source-change notification hookup to the already-owned coordinator. Keep source-cache refresh and scheduler request coalescing; do not add a release fetcher or credential flow.
- Focused server tests beside the owning modules, including slot reuse, production preparation/retirement scenarios, source-trigger integration, and physical inventory/architecture gating. Any edited source/test file must remain at or below 400 lines; split by the repository's dot-notation convention if necessary.
- Existing Linux fixture helpers/tests only where required to add truthful architecture/provenance/count assertions. Do not edit generated route trees or unrelated provider/Git/orchestration/Rust code.
- This plan file is created before implementation and will be updated only with actual validation/handoff results; the 7 September plans remain unchanged.

## Invariants

- At every pre-upload, upload, health, failure, retirement, and recovery boundary, the canonical account/root has no more than two distinct executable content digests. Physical inventory and unresolved reservations count; metadata aliases do not hide extra files.
- A released reservation row is immutable evidence. Reuse creates a unique reservation identity tied to the same stable slot key; replay and ownership history cannot collide or disappear.
- Capacity CAS and retirement CAS are authoritative across target aliases/controllers. A stale writer cannot install after its slot or retirement fence is revoked.
- `current` is never retired. `predecessor` is withdrawn only in the same durable replacement intent that reserves safe retirement, and withdrawal does not release owner/recovery dependencies.
- A predecessor may be retired only after positive managed identity, fenced acquisition, no durable/local owner references, no active/uncertain/unknown launch, no competing controller selection, and verified supported shutdown/death. Unknown or unavailable evidence defers.
- No `208` payload or staging file is written until `205` deletion is durably confirmed. `207` stays present, selected, and usable throughout; any failure leaves `207` as fallback.
- Candidate install and isolated health do not alter serving selectors, existing bindings, workspace state, PTYs, journals, operation epochs, or user frames. Only deliberate admission promotes the ready candidate.
- Source changes refresh the configured process-scoped source once and coalesce target preparation. They do not prompt for credentials, fetch arbitrary channels, downgrade, or automatically select a candidate.
- Active and uncertain work stays generation/epoch-pinned. Lost replies and restart reconciliation reuse durable request identities and never replay an accepted side effect.
- Fixture-gated tests report unavailable Docker/fixtures/architectures as skips and distinguish source-built fixture provenance from published artifact authenticity.

## Acceptance criteria

- [x] Retiring/releasing slot 0 and reserving the next candidate succeeds; the released row remains, the new reservation ID is unique, and CAS parsing accepts the state. Capacity regressions cover both current and legacy rows.
- [x] Two concurrent aliases cannot create a third active slot or overwrite replay/ownership evidence; the coalesced scheduler/coordinator regressions and full remote-agent suite pass.
- [x] In the real coordinator/install path, `205 + 207 -> 208` retires `205` before the first `208` byte, retains `207`, and never exceeds two physical builds; the production-path command-order regression passes.
- [x] Active, uncertain, unknown-owned, and another-controller-selected `205` all defer safely without shutdown/deletion or loss of `207` fallback; a positively idle managed `205` retires and frees capacity.
- [ ] A definitive install/health failure after retirement leaves `207` selected and usable; this failure-path criterion was not directly revalidated in this cycle, and the Docker-backed production matrix was skipped.
- [x] A release-source/configuration change refreshes the source and causes exactly one coalesced preparation for authenticated known targets; it does not select the candidate or initiate credential prompts.
- [ ] Fresh, unmatched, and expired legacy histories remain explicitly provenance-labeled; the newly added fixture-gated coverage is present, but its Docker/fixture execution was skipped locally.
- [ ] Linux tests assert physical executable counts at relevant phases for each available architecture; the aarch64 and x86_64 gates reported an exact environment skip, so no architecture acceptance pass is claimed.
- [x] Focused server tests and applicable UI/RPC tests pass; `bun fmt`, `bun lint`, `bun typecheck`, `bun run test`, all required Rust checks, `git diff --check`, and the <=400-line audit pass, with fixture-gated skips recorded below.
- [x] No commit, tag, push, GitHub Actions, release, or remote production operation occurred.

## Validation matrix

| Area                        | Required local evidence                                                                                                                                                                                        | Truthful unavailable result                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Slot reuse                  | Capacity-focused tests pass, including released evidence retention, legacy-row parsing, fresh IDs, CAS, and stable slot reuse; the focused run passed 69 tests with 2 environment-gated skips                  | No unavailable result                                                            |
| Predecessor production path | Focused production/source suite passed; idle command order proves deletion before install and 207 retention; active/uncertain/unknown/competing cases defer                                                    | Docker-backed physical acceptance was skipped; no claim for that layer           |
| Source trigger              | Startup boundary plus coordinator/scheduler integration pass: one source refresh/preparation, no selection, and no SSH open when credentials are unavailable                                                   | No unavailable result                                                            |
| Replay/selection            | Full server suite passed: 697 files / 2,896 tests passed; 13 files / 37 tests were existing Linux/optional skips                                                                                               | No unavailable result                                                            |
| Linux aarch64               | Fixture-gated source-built/provenance/count test is implemented; published artifact trust is intentionally not represented as a pass                                                                           | Skipped: `BIGBUD_TEST_LINUX_DOCKER=1 is not enabled`; fixture directory is unset |
| Linux x86_64                | Architecture-specific fixture/provenance/count gate is implemented; published artifact trust is intentionally not represented as a pass                                                                        | Skipped: `BIGBUD_TEST_LINUX_DOCKER=1 is not enabled`; fixture directory is unset |
| UI/RPC                      | No UI/RPC files changed; applicable startup/server tests pass as part of the focused and repository suites                                                                                                     | No frontend-specific test was needed for this server-only correction             |
| Repository gates            | `bun fmt`, `bun lint` (4 existing lint warnings, 0 errors), `bun typecheck`, `bun run test`, Rust fmt/clippy/test, `git diff --check`, and the line audit all pass; 29 existing oversized-test warnings remain | No unavailable repository gate                                                   |

### Exact local results

- `bun run --cwd apps/server vitest run` over the slot-capacity, retirement, coordinator, startup, inventory, registry, admission, server-layer, and Linux-acceptance files: 8 files passed, 1 skipped; 69 tests passed, 2 skipped.
- `bun run --cwd apps/web vitest run src/rpc/wsNativeApi.remoteAgent.test.ts`: 1 file and 1 test passed.
- `bun fmt`: passed; oxfmt processed 7,353 files. `bun lint`: passed with 4 existing lint warnings and 29 existing oversized-test warnings, 0 errors. `bun typecheck`: 9 package tasks passed.
- `bun run test`: all 9 package tasks passed; server reported 697 files / 2,896 tests passed and 13 files / 37 tests skipped. These are existing Linux/optional gates; no skipped test was reported as passing.
- `cargo fmt --all --check`, `cargo clippy --locked --workspace --all-targets -- -D warnings`, and `cargo test --locked --workspace`: all passed. `git diff --check`: passed. The <=400-line audit covered 243 changed/untracked source/test files, with no file over 400 lines.
- The new `remoteAgentUpgrade.acceptance.linux.test.ts` skipped both aarch64 and x86_64 cases because `BIGBUD_TEST_LINUX_DOCKER` was unset (Docker gate disabled) and `BIGBUD_TEST_AGENT_FIXTURES` was unset. Docker being installed locally does not substitute for the explicit gate or fixtures.

## Exclusions and safety boundary

Do not modify GitHub Actions, release metadata, published artifacts, tags, remotes, branches, or production SSH/VPS state. Do not commit, push, reset, clean, rebase, merge, or remove inherited dirty changes. Do not add a third build, terminate active/uncertain/unknown-owned work, revive legacy takeover scripts, create a second cleanup/scheduler authority, migrate old work, alter provider retry semantics, edit generated files, or make unrelated Git, provider, orchestration, or Rust changes. If current source reveals that a requested retirement case needs a materially different product decision or unsupported native capability, stop that subcase, preserve the safe fallback, and document the blocker rather than inventing behavior.

## Local execution and handoff record

Implementation and local validation are complete for the applicable residuals. The residual-cycle implementation/test files are `remoteAgentInstall.registry.ts`, `remoteAgentUpdate.state.ts`, `remoteAgentInstall.registry.transitions.ts`, `remoteAgentUpdate.capacity.test.ts`, `remoteAgentInstall.registry.retirement.ts`, `remoteAgentInstall.retirement.ts`, `remoteAgentInstall.stage.ts`, `remoteAgentInstallManager.ts`, `remoteAgentServerLayer.ts`, `remoteAgentUpdate.retirement.test.ts`, `remoteAgentUpdate.coordinator.test.ts`, `serverRuntimeStartup.ts`, `serverRuntimeStartup.test.ts`, and `remoteAgentUpgrade.acceptance.linux.test.ts`, all under `apps/server/src` except this plan. The implementation uses stable slot keys with fresh reservation identities, the existing production install/stage capacity hook and retirement/native-shutdown authorities, and coalesced scheduler/coordinator source-change handling. The actual settings boundary is covered by `watchRemoteAgentSourceChanges` in `serverRuntimeStartup.ts`; no arbitrary channel or credential flow was added. The new Linux acceptance cases are exact skips in this environment: `BIGBUD_TEST_LINUX_DOCKER` is unset (Docker gate disabled) and `BIGBUD_TEST_AGENT_FIXTURES` is unset, so neither aarch64 nor x86_64 physical fixture execution is claimed. Definitive post-retirement failure and full fresh/unmatched/expired fixture execution remain risks for a Docker/fixture-enabled handoff. The worktree remains heavily dirty with inherited changes; no commit, tag, push, GitHub Actions, release, or remote operation occurred.
