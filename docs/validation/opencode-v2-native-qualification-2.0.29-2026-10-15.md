# OpenCode V2 native qualification of 2.0.29 — preparation ledger (gap closure Phase 1)

## Status

**Prepared, not executed. G1 NOT met. Code green (preparation code only): YES. Implementation/Plan green: NO.**

Plan: [2026-10-15 gap-closure plan](../plans/2026-10-15-opencode-v2-gap-closure-plan.md), Phase 1 items 1.1–1.4.

Validated tree: `f3635eaa5` plus the uncommitted Phase 1 preparation changes listed below. The orchestrator records the final SHA. Nothing ran on a qualification runner, no retail OpenCode binary was executed, no reviewer session was launched, and nothing was pushed. Network use was read-only: npm registry metadata and tarball for `@opencode/cli-darwin-arm64@2.0.29`, and `git ls-remote` against `https://github.com/anomalyco/opencode`, the repository named in the package's own `package.json`.

## Blockers that need a plan or user decision before G1 can pass

1. **12 of the 30 mapped files cannot pass against a 2.0.29 image (plan §1.2 is materially wrong).**
   - **Cause:** every file gated on `BIGBUD_OPENCODE_V2_TEST_BINARY` launches through the private owned-process launcher. That path is `ServerManager.fixture.ts` / `Application.fixture.ts` → `startOwnedV2Process`, which calls `assertDevelopmentVersion` (`Compatibility.ts:8-14`), and that function accepts exactly CLI `2.0.26` (`OPENCODE_V2_CLIENT_VERSION`). Against 2.0.29 these files fail. Run against 2.0.26 instead, the evidence binary would differ from the record's `testedBinarySha256`, which `prepareV2NativeQualificationRecord` rejects.
   - **Additional problems:** `Catalog.native.test.ts` also needs public internet (`BIGBUD_OPENCODE_V2_PUBLIC_CATALOG_SMOKE=1`). `Execution.application.native` and `Execution.lifecycle.native` spawn the seatbelt executor, and a nested `sandbox-exec` fails under the egress sandbox (verified locally: `sandbox_apply: Operation not permitted`, exit 71).
   - **Coverage impact:** every shared-mode native test is already in the mapping. Without the 12 files, `native-tool-schema-catalog-permissions` keeps only `Orchestration.approval.native`, and `isolation-hooks` keeps only the non-native `SharedService.native.isolation.test.ts`.
   - **Options:**
     - (a) Port the scope-relevant files (tools, permissions, model, access modes, context, attachments, deletion contract, load) to the shared fixture `sharedServiceNativeFixture`, and drop `Catalog.native` (owned path plus public network). This needs a plan amendment and test authoring.
     - (b) Narrow the scope definitions to the shared path, accepting reduced coverage and a new suite revision.
     - (c) Allow the private launcher to accept the approved retail version. This is not recommended, because the private path is not production (shared-only per the plan's non-goals), so it would qualify the wrong path.
   - **Current state:** the blocked files are listed in `V2_NATIVE_QUALIFICATION_BLOCKED`, and the suite stays as the plan wrote it, so a qualify run fails visibly instead of being silently narrowed. Recommendation: (a), decided by the planner.
2. **Whole-host `pfctl` loopback-only egress would cut the hosted runner's own connection to GitHub.** On a hosted runner, that connection is outbound from the same machine. I implemented process-scoped seatbelt egress instead: `scripts/opencode-v2-qualification-egress.sb`, applied with `sandbox-exec -f` around each scope run. Verified locally: in-sandbox loopback HTTP 200, external HTTPS `EPERM`. The profile's SHA-256 is part of the environment and runner evidence. This replaces the plan's `sudo pfctl` (A3 wording).
3. **The plan's approval id `gh-macos-15-arm64-opencode-2.0.29` fails the approval schema**, which requires `^[a-z0-9-]{1,100}$` (`validateV2NativeIsolationApproval`). I used `gh-macos-15-arm64-opencode-2-0-29`.
4. **A3** (accepting a GitHub-hosted `macos-15` runner) and the **three distinct top-level reviewer sessions** remain user actions.

## Trigger decision

GitHub dispatches `workflow_dispatch` only for workflows that exist on the default branch, so the job cannot be dispatched from this branch before merge. The new job `macos-arm64-qualification` runs only when either:

- `push` to a branch named `task/opencode-v2-qualify-*`. Such pushes already match the workflow's `task/opencode-v2-*` filter, and the job condition requires the `qualify-` prefix, so ordinary `task/opencode-v2-*` pushes never run it; or
- after merge, `workflow_dispatch` with the boolean input `qualification: true`.

This makes it runnable without merging, never automatic on routine task pushes, and opt-in by an explicit branch name. The existing `windows`/`unix` jobs are unchanged; they also run on a `qualify-` push.

## Precomputed values (derived locally; none hand-typed)

| Value                                                | Value                                                                                             | Source                                                                                                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm integrity                                        | `sha512-2tJOM20RpOjNeWsYcV3VfRFPDTeu1yMMbEqAQm1sEKmHX9087Sx/TxhwBlvtiudOGq6Kr3zyKmW1t7aFF6qCsQ==` | `registry.npmjs.org/@opencode%2Fcli-darwin-arm64/2.0.29` `dist.integrity` (shasum `731d34b53edde13fcaa1a88c1f1d9de52cda510d`); pinned in `scripts/opencode-v2-fixture.ts`               |
| Tarball URL                                          | `https://registry.npmjs.org/@opencode/cli-darwin-arm64/-/cli-darwin-arm64-2.0.29.tgz`             | same metadata; pinned                                                                                                                                                                   |
| `executableSha256` (`package/bin/opencode`)          | `7f46ba1dad86b730903d9adf54015bb4e706fc1ab6a247affc5a635cd8a663f3`                                | `node scripts/opencode-v2-fixture.ts 2.0.29 <tmp>/fixture --qualification` (sha512 verified, extracted, `chmod 0555`, never executed); independently `shasum -a 256`. 186,170,000 bytes |
| `nativeSourceCommit` (tag `v2.0.29`)                 | `042d0832f5f3a73eaa039a58a7d565776f6d4290`                                                        | `git ls-remote --tags https://github.com/anomalyco/opencode` (lightweight tag; `v2.0.28` resolves to `026b106bc5d41b679ffc413264229c340871e4d3`, matching the 10-14 plan)               |
| `V2_NATIVE_CONTRACT_DIGEST`                          | `c7553d8d07f5200ff0108e491d71050b2a679e877df468e12276b7be0db90473`                                | `bun -e` import of `NativeCompatibility.contract.ts`                                                                                                                                    |
| `V2_COMPATIBILITY_DIGEST`                            | `778d3563d74e7eadf9a0169b4831b2555a50735c2eeabc82887010a683cce2b0`                                | `bun -e` import of `Orchestration.compatibility.ts`                                                                                                                                     |
| `generatorSourceDigest`                              | `3321f844dc958e2aed158d5afc062371b61db3f09f6c62dcf23a1f6807c34a31`                                | `bun run --cwd apps/server thread-tools:native-qualification:check` (`qualifiedRecords: 0`); unchanged since Phase 0 because no closure file changed                                    |
| Approval: id / machineId                             | `gh-macos-15-arm64-opencode-2-0-29` / `github-macos-15-arm64`                                     | `V2_NATIVE_QUALIFICATION_TARGET`                                                                                                                                                        |
| Approval: fixtureRoot / executablePath               | `/Users/runner/work/_temp/opencode-v2-qualification` / `…/fixture/package/bin/opencode`           | the job asserts `RUNNER_TEMP` = `/Users/runner/work/_temp` and that it is a real path                                                                                                   |
| Approval: controlledPath / platform / arch / version | `/usr/bin:/bin:/usr/sbin:/sbin` / `darwin` / `arm64` / `2.0.29`                                   | target                                                                                                                                                                                  |
| Approval: `imageDigest`, `environmentEvidenceDigest` | **runner-only**                                                                                   | produced by the job's `provision` pass (runner image version and tool versions); never committed as placeholders                                                                        |
| `sourceSnapshotDigest`                               | **runner-only** (SHA-256 of `git ls-tree -r --full-tree HEAD` at the qualified commit)            | `assembleThreadToolNativeQualification.ts snapshot`; reviewers must review the same digest                                                                                              |

## Scope → file list (`suiteRevision: "opencode-v2-native-qualification-suite.v1"`)

Single source: `apps/server/src/provider/Layers/OpencodeV2/NativeCompatibility.qualification.suite.ts`. The job reads it through `assembleThreadToolNativeQualification.ts files <scope>`. All 30 files exist (asserted by test). Every `it.skipIf` and the condition that must hold on the runner for `skipped: 0`:

| Scope                                  | File                                                                                                   | Skip condition (must be false on runner)                                                                           | Blocked |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------- |
| api-transport-admission                | SharedService.native / .application.native / .logical.native / .context.native / .model.routing.native | `!SHARED_TEST_BINARY \|\| !SHARED_TEST_VERSION` (application, logical: hard-fail if `REQUIRED_NATIVE=1` and unset) | no      |
|                                        | Runtime.native                                                                                         | `!TEST_BINARY`                                                                                                     | **yes** |
| native-tool-schema-catalog-permissions | Runtime.tools.native, Runtime.permissions.native, Runtime.model.native                                 | `!TEST_BINARY`                                                                                                     | **yes** |
|                                        | Catalog.native                                                                                         | `!TEST_BINARY \|\| PUBLIC_CATALOG_SMOKE !== "1"`                                                                   | **yes** |
|                                        | Orchestration.approval.native (each ×2)                                                                | `!SHARED_TEST_BINARY`                                                                                              | no      |
| isolation-hooks                        | SharedService.native.isolation (unit)                                                                  | none                                                                                                               | no      |
|                                        | Execution.application.native, Execution.lifecycle.native                                               | `!TEST_BINARY \|\| platform !== "darwin"`                                                                          | **yes** |
|                                        | Runtime.accessModes.native                                                                             | `!TEST_BINARY`                                                                                                     | **yes** |
| rpc-crypto-cancellation                | Orchestration.plugin.native, .production.native, .readiness.failure.native                             | `!SHARED_TEST_BINARY`                                                                                              | no      |
| history-receipt-approval-integration   | SharedService.history.native                                                                           | `!SHARED_TEST_BINARY \|\| !SHARED_TEST_VERSION` (hard-fail if required)                                            | no      |
|                                        | Orchestration.lifecycle.native                                                                         | `!SHARED_TEST_BINARY`                                                                                              | no      |
|                                        | Runtime.deletion.contract.native, Runtime.load.native                                                  | `!TEST_BINARY` (load: optional `TEST_METRICS`)                                                                     | **yes** |
| source-config-autoload                 | PluginSetup.autoload.native (×2), PluginSetup.application.native (×2)                                  | `!SHARED_TEST_BINARY`                                                                                              | no      |
|                                        | NativeCompatibility.sources (unit)                                                                     | none                                                                                                               | no      |
| two-location-lifecycle                 | Orchestration.stable.native                                                                            | `!SHARED_TEST_BINARY`                                                                                              | no      |
|                                        | Runtime.context.native / Runtime.attachments.native                                                    | `!TEST_BINARY` (attachments also `platform !== "darwin"`)                                                          | **yes** |
| packaged-ab                            | Orchestration.production.packaged, Packaging.artifacts                                                 | none                                                                                                               | no      |

**A4:** `NativeCompatibility.sources.test.ts` is a pure validator unit test. The 2.0.29 source ordering is actually exercised by the candidate fixtures (`BIGBUD_OPENCODE_V2_CANDIDATE_SEMANTIC_PROFILE=v2-system-global-config-v1`) in `PluginSetup.*` and `Orchestration.*` native files. If 2.0.29 differs, those fail, and the record must take the proven profile under a new suite revision.

## Runbook (two passes on the hosted runner)

1. **Provision.** Push the commit to `task/opencode-v2-qualify-<name>`. The approvals catalog has no target entry, so the job selects `provision`. It:
   - verifies the runner layout;
   - downloads the pinned package (sha512, `chmod 0555`, SHA-256);
   - exports the exact environment;
   - runs `assembleThreadToolNativeQualification.ts provision`, which writes `runner-provisioning.json`, `environment-evidence.json`, `approval.json` and `fixture.json` to the artifact.

   Nothing is launched in this pass.

2. **Commit the approval.**
   - Copy `runner-provisioning.json` verbatim to `docs/validation/opencode-v2-qualification-runner-<date>.json`; its SHA-256 equals `approval.imageDigest`.
   - Paste `approval.json` verbatim into `V2_NATIVE_ISOLATION_APPROVALS` (`SharedService.native.isolation.approvals.ts`).
   - Commit, then push to the same `qualify-` branch.
3. **Qualify.**
   - The job selects `qualify`, and `verify` refuses if the runner image or environment changed (in that case, re-provision; never relabel).
   - It records the binary SHA-256, then runs the eight scopes, each as `sandbox-exec -f scripts/opencode-v2-qualification-egress.sb bun run --cwd apps/server vitest run <files> --reporter=default --reporter=json --outputFile.json=$QUAL_OUT/scope-<scope>.json`.
   - It records the SHA-256 again and writes `qualification-summary.json` (before/after hashes, snapshot digest, environment digest, `generatorSourceDigest`, `completedAt`).
   - It uploads everything.
4. **Reviews.** The user launches three distinct top-level sessions (code, security, requirements) against the summary's `sourceSnapshotDigest`, and records `reviews.json` as `{ code|security|requirements: { status: "passed", reviewer: "ses_…", sourceSnapshotDigest } }`.
5. **Evidence.** Run `bun apps/server/scripts/assembleThreadToolNativeQualification.ts evidence <downloaded artifacts> --reviews reviews.json`. It writes `docs/validation/opencode-v2-native-qualification-2.0.29-evidence.json` and refuses any scope with failures or skips.

## Promotion steps

1. `bun run --cwd apps/server thread-tools:native-qualification:prepare docs/validation/opencode-v2-native-qualification-2.0.29-evidence.json --check`
2. The same command without `--check`. Paste the printed record verbatim into `V2_NATIVE_RELEASE_QUALIFICATIONS` (`NativeCompatibility.qualification.registry.ts`), typed as the record type instead of `unknown[]`.
3. `bun run --cwd apps/server thread-tools:native-qualification:check` must print `qualifiedRecords: 1`, `qualified: true` and `generatorSourceDigest: 3321f844…` (unchanged). `thread-tools:manifest:check` must pass.
4. `bun run --cwd apps/server build` must pass.
5. The real-registry invariant in `NativeCompatibility.qualification.test.ts` already accepts "empty, or exactly the darwin/arm64 2.0.29 suite-v1 record", so promotion needs no test edit. Optionally tighten it to exactly one record after promotion.

## Preparation dry run (synthetic, tmp only, nothing committed)

Synthetic scope reports plus a summary went through `evidence` and the real `prepareThreadToolNativeQualification.ts`. Without reviews the packet was rejected (`Missing key`). With three distinct `ses_` reviews it printed `Completed qualification evidence structure/identity verified`, with `suiteRevision` v1, `nativeSourceCommit 042d0832…`, contract digest `c7553d8d…` and profile `v2-system-global-config-v1`.

## Changes

- `scripts/opencode-v2-fixture.ts`: 2.0.29 added; darwin-arm64 integrity and tarball pinned; `chmod 0555` on non-Windows; `--qualification` exports `BIGBUD_OPENCODE_V2_TEST_BINARY` and writes `fixture.json`.
- New `scripts/opencode-v2-qualification-egress.sb` (seatbelt loopback-only profile).
- `.github/workflows/opencode-v2-shared.yml`: the `qualification` dispatch input and the `macos-arm64-qualification` job (parsed with PyYAML; actionlint is not installed).
- New `apps/server/scripts/assembleThreadToolNativeQualification.ts` (CLI subcommands: mode, scopes, files, snapshot, env, provision, verify, summary, evidence).
- New `NativeCompatibility.qualification.suite.ts` (target, suite v1, blocked list) and `NativeCompatibility.qualification.assemble.ts` (pure assembly), with `NativeCompatibility.qualification.assemble.test.ts`.
- `NativeCompatibility.evidence.ts`: `v2NativeQualificationResultsDigest`, shared by assembly and validation.
- New `SharedService.native.isolation.approvals.ts`, holding the catalog split out of the fixture (still empty).
- `ServerManager.retail.isolation.test.ts`: inert-approval cases (private, shared, approval gate) with `BIGBUD_OPENCODE_V2_NATIVE_MACHINE_ID` unset, using a synthetic record through the mocked catalog, plus a darwin/arm64 positive control.
- `NativeCompatibility.qualification.test.ts` and `Orchestration.production.runtimePolicy.test.ts`: mocked empty registry, plus the real-registry invariant (2.0.29 added to both version lists).

## Commands (worktree root)

| Command                                                                                                                                                                                                                                                                               | Exit | Result                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------- |
| `bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/NativeCompatibility.qualification.test.ts src/provider/Layers/OpencodeV2/NativeCompatibility.runtime.qualified.test.ts src/provider/Layers/OpencodeV2/Orchestration.production.runtimePolicy.test.ts` (plan 1.4) | 0    | 42 passed                                                                    |
| Focused set: retail isolation, isolation, assemble, evidence, qualification, runtime.qualified, runtimePolicy, candidate                                                                                                                                                              | 0    | 8 files / 68 tests passed                                                    |
| `bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2`                                                                                                                                                                                                                 | 0    | 219 passed / 37 skipped files (256); 924 passed / 50 skipped tests; 0 failed |
| `bun fmt`, `bun lint`, `bun typecheck`, `bun fmt:check`                                                                                                                                                                                                                               | 0    | lint 63 warnings (none in changed files); typecheck 9/9                      |
| `bun run --cwd apps/server build`                                                                                                                                                                                                                                                     | 0    | `qualifiedRecords: 0`, `generatorSourceDigest 3321f844…` (unchanged)         |
| YAML parse (`python3` PyYAML `safe_load`)                                                                                                                                                                                                                                             | 0    | 3 jobs; qualification job 21 steps                                           |

No full root `bun run test` was rerun, because changes are confined to `apps/server/src/provider/Layers/OpencodeV2`, `apps/server/scripts`, root `scripts/` and `.github`.
