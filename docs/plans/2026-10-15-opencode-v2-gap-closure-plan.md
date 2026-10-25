# OpenCode V2 gap closure: declare the shared-service provider fixed

**Date:** 15 October, 2026
**Status:** Proposed
**Owner:** OpenCode V2 provider maintainers (planning agent; autonomous draft, no user round-trip)

**Inspected tree:** live checkout `/Users/youpele/DevWorld/bigbud`, branch `plan/terminal-rust-gpu-reliability`, HEAD `2c2627b83`, dirty (532 porcelain entries: 169 modified, 363 untracked, ~36k lines; counts from the 2026-10-15 assessment). This plan is committed on `plan/terminal-rust-gpu-reliability` alongside that dirty work; the dirty files themselves stay uncommitted until Phase 0. All paths below are relative to the repository root of the live checkout.

## Summary

The OpenCode V2 provider (borrowed shared native daemon, required canonical thread tools, automatic plugin setup, reboot recovery) is engineering-complete for **macOS ARM64 shared-service mode** but cannot be called fixed: the working tree is uncommitted, six server tests contradict the qualification gate, the native qualification registry is empty so every retail 2.x release is reported as unqualified, no billed live turn through the shared daemon has been recorded, and the October 14 live sends failed with "prior physical admission remains owned". This plan defines "fixed" as a checkable Definition of Done, orders the remaining work into five gated phases (stabilize and commit, native qualification of 2.0.29, live-send diagnosis plus a backend instance lock, one documented live turn, cleanup and docs), and formally defers Windows/Linux native execution and seven smaller items to named follow-ups.

User impact when done: a user on macOS ARM64 with OpenCode 2.0.29 running enables the provider, acknowledges expanded trust once, sees a green "ready" status (not amber "unqualified"), and can send, use thread tools, interrupt and send again without a stuck "settlement unconfirmed" state.

## Related Work

- Bigbud note / Kanban card: None identified. The effort is tracked only through plans and validation ledgers; recording a Kanban card is an open question.
- Provider report: [docs/reports/providers-opencode-v2.md](../reports/providers-opencode-v2.md) (states "The current working registry is empty").
- Plans amended or superseded here: [2026-09-29 implementation plan](2026-09-29-opencode-v2-provider-implementation-plan.md) (AC2/AC3/D8), [owned deletion design](2026-10-09-opencode-v2-owned-deletion-design.md) (Draft), [canonical thread tools](2026-10-12-opencode-v2-canonical-thread-tools-plan.md), [stable bootstrap](2026-10-13-opencode-v2-stable-bootstrap-maintenance-plan.md), [contract compatibility amendment](2026-10-14-opencode-v2-contract-compatibility-plan.md) (§1a "runtime checks + warning", §7.1 hermetic gate). The completed adoption and superseded shared-service/automatic-setup plans were retired on 22 October, 2026; their contracts survive in the [consolidated provider decisions](../reports/providers-opencode-v2.md#consolidated-adoption-and-setup-decisions), without closing qualification gates.
- Ledgers relied on: [v6 source corrections](../validation/opencode-v2-contract-compatibility-v6-source-2026-10-14.md) (root run 21 failed files / 70 failed tests on v5), [cross-platform recovery](../validation/opencode-v2-cross-platform-recovery-2026-10-14.md) (attempts 3–6, RangeError cycle, duplicate backends, settlement defect), [retired local root-check summary](../validation/README.md#retired-records) (AGENTS.md/Turbo formatting interaction), [Effect RPC ownership repair](../validation/effect-rpc-ownership-repair.md).
- Unrelated work tangled into the same tree: [ChatGPT plan integration](2026-10-11-chatgpt-plan-integration-plan.md) (Status: Proposed).

## Problem

Observed facts (verified 2026-10-15 unless cited):

1. **Gate/test contradiction.** `apps/server/src/provider/Layers/OpencodeV2/Development.provider.ts:80-83,142` sets `status: "warning"` when the shared runtime is a canonical 2.x candidate with no registry record; `NativeCompatibility.qualification.registry.ts` exports two empty frozen arrays. `Development.shared.test.ts:37` and the five `it.each` cases in `Development.provider.diagnostics.test.ts:58` mock `2.0.24` and expect `"ready"`. Result: 6 failing server tests (1,048 pass / 6 fail / 50 skipped across 286 V2 files).
2. **Empty registry by design.** `NativeCompatibility.qualification.ts:86-111` returns no evidence, so `NativeCompatibility.runtime.ts` yields `evidenceKind: "runtime-checked"`; `NativeCompatibility.status.ts:25-35` renders amber "semantic qualification is incomplete" for every retail release. Retail execution of 2.0.28/2.0.29 is blocked because `SharedService.native.isolation.fixture.ts:27` has `approvals = []` and **all** retail launch paths (`ServerManager.child.ts:203`, `SharedService.native.fixture.ts:50`, `NativeCompatibility.candidate.fixture.ts`) call `requireV2NativeIsolation`. Setting `BIGBUD_OPENCODE_V2_TEST_BINARY` alone therefore cannot run the 19 `*.native.test.ts` files that read it.
3. **No recorded successful live turn.** Attempt 6 setup reached `ready` on 2.0.29 (PID 12872), but four `sendTurnAttempt` failures followed: `Runtime.send.ts:67` "V2 prior physical admission remains owned; no new turn." Attempt 5 reproduced a `RangeError` guard cycle (`NativeCompatibility.runtime.ts` → `PluginSetup.publication.ts`), since fixed in source (`NativeCompatibility.runtime.ts:180-183` comment). Two backends (launchd Node on 3773, Electron on 3774) opened `~/.bigbud/dev/state.sqlite` concurrently; `apps/server/src/startup/config.ts:75-76` derives one `state.sqlite` per `baseDir` and `persistence/Layers/Sqlite.ts:37-39` uses WAL + `busy_timeout` only. There is no application-level instance lease.
4. **Candidate root cause for the permanent hold (hypothesis H1, medium confidence).** `Execution.owners.ts:14-21` adds a dispatched-then-failed controller to `uncertain` and never removes it; `busyCount()` (line 41) includes it; `Runtime.activation.ts` `settleV2RuntimeReservation` returns early while `owner.coding?.busyCount?.()` is non-zero; `Runtime.settlement.ts:84-99` then reports "settlement remains unconfirmed" forever. A guard-cycle exception inside a dispatched execution (attempt 5) is exactly that path.
5. **Tree hygiene.** `bun fmt:check` fails only on `AGENTS.md` (Turbo rewrites its managed block and removes the blank line oxfmt inserts; documented in the 2026-10-12 ledger). `bun lint` passes with 64 warnings, including an unused `oxlint-disable-next-line preserve-caught-error` at `NativeCompatibility.policy.ts:63`. `bun typecheck` passes. Retired modules (`Development.composition.ts`, `ServerManager.ssh.ts`, `ServerManager.ssh.bootstrap.mjs`, `Coding.transport.ts`, `Application.targets.ts`, `Application.config.ts`) have no production importers but are still imported by `Application.fixture.ts` and 15+ test files. The last full root `bun run test` (v5 snapshot) had 70 failures, untriaged. `docs/CHANGELOG.md` v0.3.0 is still "xx October, 2026" with no OpenCode entry.
6. **Review debt.** Every v3–v6 green is self-review; nested independent review failed with "Subagent depth limit reached (1)".

## Goals

- A precise, checkable Definition of Done (below) after which the effort is declared **Implementation/Plan green** for macOS ARM64 shared-service mode.
- One committed, immutable snapshot series with `bun fmt:check`, `bun lint`, `bun typecheck` and full root `bun run test` green, plus Rust checks green because `crates/bigbud-remote-agent/src/inspect_local/windows.*` changed.
- One retail release (2.0.29, darwin/arm64) qualified and promoted into `V2_NATIVE_RELEASE_QUALIFICATIONS`, so the provider reports `evidenceKind: "qualified"` and a green status.
- A diagnosed and fixed cause for "prior physical admission remains owned", a backend instance lock for the shared state directory, and one documented live billed turn (consent → setup → thread-tool round trip → interrupt → next send).
- Retired modules removed, stale acceptance criteria amended by dated addenda, CHANGELOG and provider report updated, deferred items named with owners and triggers.

## Non-Goals

- Windows or Linux native execution, Windows publication validation (DuplicateHandle/GetMappedFileNameW), real reboot/hibernation tests. Deferred (see "Deferred work").
- Owned native-history deletion (10-09 design stays Draft), Big Pickle vendor predicate, the 10 MiB native media HTTP 500, recursive-delete atomicity, `~/Documents` EPERM, reboot receipt "unknown" resolution.
- Any change to native OpenCode accounts, credentials, config JSON/JSONC, the user's daemon lifecycle, or the pinned `@opencode/client` 2.0.26 package.
- Re-opening architecture decisions: shared-only production, no isolated/private/SSH fallback, five canonical tools, fail-closed setup, retained-history semantics.

## Current State

- Provider dispatch: `apps/server/src/provider/Layers/ProviderService.ts`; V2 layer: `apps/server/src/provider/Layers/OpencodeV2/` (553 files). Discovery: `Development.provider.ts`. Send/admission: `Runtime.send.ts`, `Runtime.admission.ts` (305 lines), `Runtime.admission.owner.ts`, `Runtime.activation.ts`, `Runtime.settlement.ts`, `Execution.owners.ts`, `PluginSetup.activation.gate.ts` (`V2ActivationGate.settle` requires physical + durable + nativeDrained + callbacksSettled). Request authority: `Client.guard.ts` (gates `/api/config` and `/api/rpc/`).
- Qualification: `NativeCompatibility.types.ts` (`V2NativeQualificationRecord`, 8 scopes), `NativeCompatibility.qualification.ts`, `.registry.ts`, `.evidence.ts` (`V2NativeQualificationEvidence` packet with three `ses_` reviews), `.platform.ts` (key = `[version, platform, arch]`), `.version.ts` (any canonical 2.x is a candidate). Scripts: `apps/server/scripts/checkThreadToolNativeQualifications.ts` (`thread-tools:native-qualification:check`, runs in `build`), `prepareThreadToolNativeQualification.ts` (`thread-tools:native-qualification:prepare`), `generateThreadToolImplementationManifest.ts` (`thread-tools:manifest:check`). The generator closure deliberately excludes the registry, so promotion never changes bootstrap bytes.
- Native fixtures: `SharedService.native.isolation.fixture.ts` (approval record shape, 14 fields, `platform: "darwin"`, `arch: "arm64"`, binary must be a non-writable single-link file owned by the test user), `SharedService.native.fixture.ts`, `NativeCompatibility.candidate.fixture.ts` (needs `BIGBUD_OPENCODE_V2_CANDIDATE_SOURCE_SNAPSHOT_DIGEST` and `..._SEMANTIC_PROFILE`). CI: `.github/workflows/opencode-v2-shared.yml` already runs disposable 2.0.24/2.0.26 fixtures on `macos-14` (Apple Silicon) and Windows via `scripts/opencode-v2-fixture.ts` (allowlist `2.0.24|2.0.26`, npm `@opencode/cli-darwin-arm64`, sha512 integrity).
- Web: `apps/web/src/components/chat/provider/ProviderModelPicker.models.ts:70-82` keeps `opencodeV2` selectable under `status: "warning"` when `modelCount > 0`; `apps/web/src/models/provider/composerVisibility.models.ts:24-26` excludes `opencodeV2` from fallback regardless of status. Settings show retry affordances on warning (`ProvidersSettingsSection.opencode.ts:34`).
- Persistence: migration 127 `apps/server/src/persistence/Migrations/127_OpencodeV2SharedBindings.ts` registered in `Migrations.ts:130,258`; service `persistence/Services/OpencodeV2SharedBindings.ts`.
- Repository commands (AGENTS.md): `bun fmt`, `bun lint`, `bun typecheck`, `bun run test` (never `bun test`), `cargo fmt --all --check`, `cargo clippy --locked --workspace --all-targets -- -D warnings`, `cargo test --locked --workspace`; 400-line hard limit (only `Runtime.ts` is within 5 lines at 397).

## Assumptions

Stated because the plan was written autonomously; each is verifiable before the phase that depends on it.

- A1. **Release scope is macOS ARM64 shared-service mode.** Evidence: the only recorded live setup success (attempt 6) and all production thread-tool qualification runs are darwin/arm64; the isolation approval schema accepts only `darwin`/`arm64`; Windows publication has never executed natively; Linux installation was never run. No evidence argues for a broader first release. Windows/Linux are deferred to a named follow-up (Phase 4.6).
- A2. **Tests change, not the gate.** The amber `"warning"` for unqualified runtimes is the deliberate 10-14 §1a policy ("missing qualification is disclosed, not a gate") and matches `v2NativeReadyNotice` severity; the web keeps the provider usable (Current State). The six tests encode the pre-amendment expectation. Phase 0.1 updates the tests and adds a mocked-registry "ready" case. The alternative (keep `"ready"` and move the disclosure to the message only) would hide a product-relevant state from `ProvidersSettingsSection.logic.ts:90` and is rejected.
- A3. **GitHub-hosted `macos-15` (Apple Silicon, ephemeral) satisfies the "approved clean macOS ARM64 runner" prerequisite** of the 10-14 plan §7.1 when the workflow records image provenance, uses a fixture-owned root under `$RUNNER_TEMP`, and installs a `pfctl` loopback-only egress rule before native launch. A local Tart/UTM VM is the fallback if the user rejects hosted runners. The user's development Mac is **not** eligible (it has accounts, keychain, the live daemon and `~/Documents` TCC state).
- A4. **2.0.29 uses semantic profile `v2-system-global-config-v1`** (the source ordering inspected for 2.0.28). Verified in Phase 1.2 by `NativeCompatibility.sources.test.ts` against the fixture; if it differs, the record uses the profile the sources test proves and the plan is amended.
- A5. **Committing is wanted but requires the user's go-ahead at the moment of execution.** Phase 0.4 prepares the split; the implementing agent asks once before the first commit.
- A6. The 70 root-test failures on the v5 snapshot were largely environmental (PTY unhandled error, timeouts) rather than V2 regressions; Phase 0.5 triages rather than assumes.

## Definition of Done ("fixed")

All of the following hold on one immutable commit SHA recorded in the final ledger:

1. `bun fmt:check`, `bun lint` (0 errors; 0 warnings under `apps/server/src/provider/Layers/OpencodeV2/` and `packages/contracts/src/core/settings.opencodeV2*.ts`), `bun typecheck` (9/9 tasks) and full root `bun run test` exit 0, run sequentially from the repository root. `cargo fmt --all --check`, `cargo clippy --locked --workspace --all-targets -- -D warnings`, `cargo test --locked --workspace` exit 0 on macOS.
2. `bun run --cwd apps/server thread-tools:native-qualification:check` prints `qualifiedRecords: 1`, `qualified: true`, and `thread-tools:manifest:check` passes with an unchanged `generatorSourceDigest` relative to Phase 0 (registry promotion changed no bootstrap bytes).
3. `V2_NATIVE_RELEASE_QUALIFICATIONS` contains exactly one record: `nativeVersion: "2.0.29"`, `platform: "darwin"`, `arch: "arm64"`, all eight scopes `"passed"`, backed by an evidence packet validated by `thread-tools:native-qualification:prepare <packet> --check` and three distinct top-level reviewer session IDs.
4. Ledgers exist under `docs/validation/`: `opencode-v2-gap-closure-phase0-<date>.md`, `opencode-v2-native-qualification-2.0.29-<date>.md`, `opencode-v2-live-send-diagnosis-<date>.md`, `opencode-v2-live-turn-<date>.md`, `opencode-v2-gap-closure-final-<date>.md`, each stating the commit SHA, exact commands, exit codes and skip counts.
5. The live-turn ledger shows, on the developer Mac against the user's own 2.0.29 daemon: expanded trust acknowledged, automatic setup `ready` in two Locations, one billed turn that invoked at least `bigbud_thread_v1_get_thread_status` and `bigbud_thread_v1_create_thread` with signed receipts, one interrupt, and one subsequent accepted send; zero "prior physical admission remains owned" errors; exactly one backend holding the state directory lock.
6. The retired modules listed in Phase 4.1 are deleted or demonstrably still required (ledger records the importer check), stale ACs carry dated amendments, `docs/CHANGELOG.md` has the OpenCode entry, and `docs/reports/providers-opencode-v2.md` no longer says the registry is empty.
7. Platforms: darwin/arm64 in scope; win32 and linux explicitly out of scope and named in the deferred follow-up plan file.

## Phases

### Phase 0: Stabilize and commit (Gate G0)

Goal: an immutable, fully green snapshot of the current work split into reviewable commits. Dependencies: none. Independently shippable.

0.1 **Resolve the gate/test contradiction (tests change; see A2).**

- Files: `apps/server/src/provider/Layers/OpencodeV2/Development.shared.test.ts`, `Development.provider.diagnostics.test.ts`.
- Change the initial expectation for mocked `2.0.24` to `status: "warning"` with `message` containing `OPENCODE_UNQUALIFIED_RUNTIME_WARNING` (`packages/shared/src/opencodeAdvisory.ts:8`) and `models` all `availability: "available"`; keep `auth`, `runtimeUpdateRecommended: "2.0.26"` and the HTTP-500 phase assertions (`failed.status` stays `"warning"`, so assert on `failed.message` containing `${phase} (HTTP 500)` to distinguish the two warning states).
- Add one case (new file `Development.provider.qualified.test.ts`, ≤400 lines) that mocks the registry with `vi.mock("./NativeCompatibility.qualification.registry.ts", ...)` exactly as `NativeCompatibility.runtime.qualified.test.ts:14-18` does, pushes `syntheticV2QualificationRecord("2.0.24")`, and asserts `status: "ready"` and no unqualified suffix.
- Prove: `bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/Development.shared.test.ts src/provider/Layers/OpencodeV2/Development.provider.diagnostics.test.ts src/provider/Layers/OpencodeV2/Development.provider.qualified.test.ts`.

  0.2 **Lint hygiene that could become errors.** Remove the unused directive at `NativeCompatibility.policy.ts:63` (keep the `catch` without the comment, or restore `{ cause }` only if the rule demands it and the message stays credential-free). Prove: `bun lint` reports no unused-disable warning for that file.

  0.3 **AGENTS.md formatting.** Root cause: Turbo re-emits its managed block without the trailing blank line oxfmt requires. Read `node_modules/turbo/docs/README.md` first (required by the managed block). Preferred fix: add `"agentGuidance": false` to the root `turbo.json` (the block documents this opt-out and stays committed), then `bun fmt`. Fallback if the user wants the block updates: add `AGENTS.md` to `ignorePatterns` in `.oxfmtrc.json`. Prove: `bun fmt:check` exit 0 after a subsequent `bun typecheck` (Turbo invocation).

  0.4 **Split the working tree into four commits** (prepare with `git status --porcelain`, stage with explicit paths, verify each staged set with `bun typecheck` before committing; ask the user once before the first commit, A5):

1. `Effect RPC ownership repair`: `patches/effect@4.0.0-beta.43.patch`, root `package.json`, `bun.lock`, `apps/web/src/rpc/wsTransport*`, `apps/web/src/components/WebSocketConnectionSurface*`, `apps/server/src/ws/wsRpcOwnership*`, `apps/server/src/ws/wsConfigDiagnostics*`, `docs/validation/effect-rpc-ownership-repair.md`.
2. `ChatGPT plan integration plan (doc only)`: `docs/plans/2026-10-11-chatgpt-plan-integration-plan.md`.
3. `Desktop/mobile/build-script tweaks`: the remaining non-OpenCode paths under `apps/desktop`, `apps/mobile-web`, `scripts/` (enumerate from porcelain; anything ambiguous goes to commit 4 with a note).
4. `OpenCode V2 required thread tools, setup, recovery, Windows inspector`: everything under `apps/server/src/provider/Layers/OpencodeV2/`, `apps/server/scripts/*ThreadTool*`, `apps/server/scripts/prepareOpencodeV2RebootRecovery*`, `apps/server/src/persistence/**/OpencodeV2SharedBindings*`, `Migrations/127_*`, contracts `settings.opencodeV2*`, `server.opencodeV2ThreadToolsSetup*`, web setup UI (`ProviderThreadToolsSetup*`, `useOpenCodeRuntimeSetup*`, `opencodeSetup.observer*`, `useOpencodeV2RetainedHistory*`), `crates/bigbud-remote-agent/src/inspect_local/*`, `crates/bigbud-remote-agent/tests/inspect_local.rs`, `.github/workflows/opencode-v2-shared.yml`, `scripts/opencode-v2-*.ts`, all `docs/plan*/…opencode-v2…`, `docs/validation/opencode-v2-*`, `docs/reports/providers-opencode-v2.md`, plus the Phase 0.1–0.3 edits.

- Commit messages end with the attribution line required by the session. No push.

  0.5 **Full root green on the snapshot.** Run sequentially from the repository root on commit 4's SHA: `bun fmt:check`, `bun lint`, `bun typecheck`, `bun run test`, then the three Cargo commands. Triage every failure: (a) in-scope V2 failure → fix, new commit, rerun; (b) pre-existing/unrelated → reproduce once on `main` or on the pre-series commit and record as unrelated with file name and reason; (c) environmental (PTY, timeouts) → rerun once with `--retry 0`; a second failure is not environmental. Record the server totals (files/tests passed/failed/skipped) and that the 50 native skips are expected without approval records.

Exit criteria (G0): all five root commands plus Cargo exit 0 on one SHA; ledger `docs/validation/opencode-v2-gap-closure-phase0-<date>.md` with the SHA, commit list, command table and unrelated-failure table. `Code green: YES` may be written; `Implementation/Plan green: NO`.

### Phase 1: Native qualification of 2.0.29 and registry promotion (Gate G1)

Goal: one genuine retail record so the provider stops reporting "unqualified". Dependencies: G0. Can run in parallel with Phase 2.

1.1 **Approved clean runner and approval record (A3).**

- Extend `scripts/opencode-v2-fixture.ts` allowlist to include `"2.0.29"`; it already verifies npm sha512 integrity. Add a step that `chmod 0555`s the extracted `bin/opencode` and prints its SHA-256 (satisfies `verifyV2NativeFixtureImage`: regular file, single link, non-writable, owned by the runner user).
- Add one `V2NativeIsolationApproval` entry to `approvals` in `apps/server/src/provider/Layers/OpencodeV2/SharedService.native.isolation.fixture.ts` (test-only module): `id: "gh-macos-15-arm64-opencode-2.0.29"`, `machineId: "github-macos-15-arm64"`, `imageDigest` = SHA-256 of a committed provisioning record `docs/validation/opencode-v2-qualification-runner-2026-10-<dd>.json` (runner label, image version from `$ImageVersion`, Xcode/OS versions, egress rule), `environmentEvidenceDigest` = SHA-256 of the exact env map the workflow exports, `fixtureRoot: "/Users/runner/work/_temp/opencode-v2-qualification"`, `executablePath` = fixture root + the extracted `bin/opencode` path, `executableSha256` = the npm-verified SHA, `nativeVersion: "2.0.29"`, `platform: "darwin"`, `arch: "arm64"`, `controlledPath: "/usr/bin:/bin:/usr/sbin:/sbin"`, the three `true` flags. Keep the file ≤400 lines (split to `SharedService.native.isolation.approvals.ts` if needed).
- Add job `macos-arm64-qualification` (`workflow_dispatch` only) to `.github/workflows/opencode-v2-shared.yml` on `runs-on: macos-15`: checkout, Bun 1.3.14, Node from `package.json`, `bun install --frozen-lockfile --ignore-scripts`, download fixture into the fixture root, record provenance JSON, apply `sudo pfctl` rule blocking outbound except `lo0`, export `BIGBUD_OPENCODE_V2_NATIVE_APPROVAL_ID`, `BIGBUD_OPENCODE_V2_NATIVE_MACHINE_ID`, `BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY`, `BIGBUD_OPENCODE_V2_TEST_BINARY`, `BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION=2.0.29`, `BIGBUD_OPENCODE_V2_CANDIDATE_SOURCE_SNAPSHOT_DIGEST` (SHA-256 over the checked-out tree manifest of the G0 SHA), `BIGBUD_OPENCODE_V2_CANDIDATE_SEMANTIC_PROFILE=v2-system-global-config-v1` (A4), then run the eight scope commands below with `--reporter=json --outputFile=$RUNNER_TEMP/scope-<name>.json`, upload artifacts.
- `ServerManager.retail.isolation.test.ts` must still refuse an unapproved binary; add a case that the approval record is inert when `BIGBUD_OPENCODE_V2_NATIVE_MACHINE_ID` is unset (local dev Macs keep skipping/refusing).

  1.2 **Scope → suite mapping (freeze as `suiteRevision: "opencode-v2-native-qualification-suite.v1"`; the implementer verifies each file still targets the scope and records the final list in the ledger):**

- `api-transport-admission`: `SharedService.native.test.ts`, `SharedService.application.native.test.ts`, `SharedService.logical.native.test.ts`, `SharedService.context.native.test.ts`, `SharedService.model.routing.native.test.ts`, `Runtime.native.test.ts`.
- `native-tool-schema-catalog-permissions`: `Runtime.tools.native.test.ts`, `Runtime.permissions.native.test.ts`, `Catalog.native.test.ts`, `Orchestration.approval.native.test.ts`, `Runtime.model.native.test.ts`.
- `isolation-hooks`: `SharedService.native.isolation.test.ts`, `Execution.application.native.test.ts`, `Execution.lifecycle.native.test.ts`, `Runtime.accessModes.native.test.ts`.
- `rpc-crypto-cancellation`: `Orchestration.plugin.native.test.ts`, `Orchestration.production.native.test.ts`, `Orchestration.readiness.failure.native.test.ts`.
- `history-receipt-approval-integration`: `SharedService.history.native.test.ts`, `Orchestration.lifecycle.native.test.ts`, `Runtime.deletion.contract.native.test.ts`, `Runtime.load.native.test.ts`.
- `source-config-autoload`: `PluginSetup.autoload.native.test.ts`, `PluginSetup.application.native.test.ts`, `NativeCompatibility.sources.test.ts`.
- `two-location-lifecycle`: `Orchestration.stable.native.test.ts`, `Runtime.context.native.test.ts`, `Runtime.attachments.native.test.ts`.
- `packaged-ab`: `Orchestration.production.packaged.test.ts`, `Packaging.artifacts.test.ts`.
- Each scope runs as one `bun run --cwd apps/server vitest run <files>`; the evidence schema requires `failures: 0, skipped: 0`, so every `it.skipIf` in these files must execute. `Remote.application.native.test.ts`, `Coding.application.native.test.ts`, `Coding.native.test.ts` and `Development.integration.native.test.ts` exercise retired owned-process paths and are excluded from scopes (they are Phase 4.1 candidates).

  1.3 **Evidence packet and promotion.**

- Author `docs/validation/opencode-v2-native-qualification-2.0.29-evidence.json` matching `V2NativeQualificationEvidence` (`NativeCompatibility.evidence.ts:9-39`): `record` fields from 1.1/1.2, `bootstrapGeneratorSourceDigest` from the `generatorSourceDigest` printed by `bun run --cwd apps/server thread-tools:native-qualification:check`, `nativeContractDigest` = `V2_NATIVE_CONTRACT_DIGEST`, `bootstrapContractDigests: [V2_COMPATIBILITY_DIGEST]` (print both from a one-off `bun -e` import; do not hand-type), `nativeSourceCommit` = the upstream `v2.0.29` tag commit from `https://github.com/anomalyco/opencode` (resolve with `ls-remote --tags`), `resultsDigest` computed exactly as `prepareV2NativeQualificationRecord` does, `binaryBefore`/`binaryAfter` from the runner's pre/post hashes, `reviews.{code,security,requirements}` with three **distinct top-level** reviewer session IDs (launch reviewers from the user's root session, not nested, to avoid the depth-limit failure).
- Validate: `bun run --cwd apps/server thread-tools:native-qualification:prepare docs/validation/opencode-v2-native-qualification-2.0.29-evidence.json --check`, then without `--check` to print the record; paste it verbatim into `V2_NATIVE_RELEASE_QUALIFICATIONS` in `NativeCompatibility.qualification.registry.ts` (typed as the record type instead of `unknown[]`).

  1.4 **Tests that assert an empty registry.** Convert `NativeCompatibility.qualification.test.ts:11-18` and `Orchestration.production.runtimePolicy.test.ts:10` to the `vi.mock` registry pattern so they assert the empty-registry behavior on a mocked empty registry, and add an assertion that the real registry has exactly one darwin/arm64 2.0.29 record. Prove: `bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/NativeCompatibility.qualification.test.ts src/provider/Layers/OpencodeV2/NativeCompatibility.runtime.qualified.test.ts src/provider/Layers/OpencodeV2/Orchestration.production.runtimePolicy.test.ts`.

Exit criteria (G1): all eight scope JSON reports show 0 failed / 0 skipped on the runner; `thread-tools:native-qualification:check` prints `qualifiedRecords: 1`; `thread-tools:manifest:check` digest unchanged from G0; `bun run --cwd apps/server build` passes; ledger `docs/validation/opencode-v2-native-qualification-2.0.29-<date>.md` (runner provenance, env map, per-scope counts, artifact digests, reviewer IDs, record ID).

### Phase 2: Live-send failure diagnosis and backend instance lock (Gate G2)

Goal: understand and fix why explicit sends are rejected after a terminal turn, and prevent two backends from sharing one `state.sqlite`. Dependencies: G0. Parallel with Phase 1.

2.1 **Backend instance lock (new, small, independently safe).**

- New `apps/server/src/startup/stateDirLock.ts` (+ `stateDirLock.test.ts`): on startup, exclusively create `<stateDir>/backend.lock` (`O_EXCL`) containing `{ pid, startedAt, port, hostname }`; if it exists, read it, check liveness with `process.kill(pid, 0)` and that the recorded `startedAt` matches the live process's start time where obtainable; a live owner → fail startup with "Another bigbud backend (pid N, port P) owns <stateDir>; stop it or use a different BIGBUD_HOME"; a dead owner → replace atomically (write temp + rename). Release on shutdown via `serverLifecycleEvents.ts`. Wire in `serverRuntimeStartup.bootstrap.ts` before persistence opens.
- No opt-out env; a diagnostic backend must use its own `BIGBUD_HOME`. Document in `docs/development/scripts.md` if the dev-runner flow (`scripts/dev-runner.ts` with `BIGBUD_DEV_INSTANCE_OFFSET`) is affected; verify by running `bun dev:server` twice.
- Prove: unit tests for fresh/live/dead/concurrent-create cases; `apps/server/src/startup/serverRuntimeStartup.test.ts` still passes.

  2.2 **Settlement hold diagnostics (observability first).**

- `Runtime.activation.ts` `settleV2RuntimeReservation`: replace silent early `return`s with a typed hold reason (`"mutations-busy" | "admission-in-flight" | "coding-busy" | "publication-unconfirmed" | "final-events" | "final-publication-pending" | "pending-interactions" | "row-not-terminal" | "unresolved-journal" | "binding" | "native-active" | "callbacks"`) returned to callers; keep the function's control flow and all fences unchanged. If the file would exceed 400 lines, put the reason type and the `busy()` classifier in `Runtime.activation.hold.ts`.
- `Runtime.settlement.ts` `repairV2RetainedReservation`: include the last hold reason in the deduplicated 30-second error status and in a redacted structured log line (thread id, native session id, reason, counts; never prompts or credentials).
- `Runtime.admission.ts` / `Runtime.admission.owner.ts`: when `captureV2AdmissionOwner`'s validator throws, the existing parenthesised reason ("dirty generation" | "hub generation" | "epoch" | "owner/process") must also reach the redacted log; `PluginSetup.activation.gate.ts`: add a read-only `snapshot()` returning `{ closed, epoch, operations: [{ key, state, physicalSettled }] }` (no tokens) so the settlement log can show which reservation holds the gate; `Client.guard.ts`: no behavior change, but `assertV2RequestContext` rejections during settlement are logged with pathname and intent only.
- Tests: `Runtime.activation.settlement.test.ts` and `Runtime.settlement.test.ts` gain reason assertions; new `Runtime.settlement.hold.test.ts`; `PluginSetup.activation.gate.test.ts` covers `snapshot()` redaction.

  2.3 **Reproduce and fix the uncertain-executor leak (H1).**

- Red test in `Execution.owners.test.ts`: `run` → `dispatch` → rejection leaves `busyCount() === 1` forever and `join()` resolves; then in `Runtime.settlement.hold.test.ts`: a session whose `coding.busyCount()` stays 1 after a failed dispatched tool call reports hold `"coding-busy"` and rejects the next send at `Runtime.send.ts:67`.
- Fix design (keep the "never manufacture idle" rule): add `V2ActiveExecutions.reconcile(controller, evidence)` that removes an `uncertain` entry only with proof (exact native session drained via `session.active` + durable receipt or interrupt acknowledgement), invoked from the settlement path before `busy()`; a timer never clears it. Mirror the semantics of `V2ActivationGate.settle`. Where `Runtime.send.ts:63-67` rejects, the error message must now carry the hold reason.
- If H1 does not reproduce the live symptom, continue with H2 (`finalPublication` pending / `finalEvents` retained), H3 (stale `pendingInteractions`), H4 (unresolved journal rows written by the other backend; this is why 2.1 precedes any live retry). Record each hypothesis, test and verdict in the ledger.

  2.4 **Guard-cycle RangeError regression guard.** Verify `NativeCompatibility.runtime.guard.test.ts` and `RebootRecovery.publication.test.ts` cover: proof validation never calls `operationGuard`; expired gate, revoked consent and aborted signal are still rejected by `captureV2OperationAuthority` (`Client.guard.ts:22-40`). If any assertion is missing, add it; do not touch the production fix.

Exit criteria (G2): red tests for the reproduced cause, green after the fix; instance lock tests green; focused suite `bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/Runtime.settlement.test.ts src/provider/Layers/OpencodeV2/Runtime.settlement.poll.test.ts src/provider/Layers/OpencodeV2/Runtime.settlement.safety.test.ts src/provider/Layers/OpencodeV2/Runtime.activation.settlement.test.ts src/provider/Layers/OpencodeV2/Execution.owners.test.ts src/startup/stateDirLock.test.ts` green; ledger `docs/validation/opencode-v2-live-send-diagnosis-<date>.md` with hypotheses table, root cause, confidence, and the full root commands rerun.

### Phase 3: One documented live turn on the developer Mac (Gate G3)

Goal: the first recorded billed end-to-end turn through the shared daemon. Dependencies: G1 (status becomes green for 2.0.29), G2 (fix + lock). User-operated; the agent prepares the runbook and reads evidence, never starts/kills the user's daemon.

3.1 Preconditions recorded in the ledger: build from the G2 SHA (`bun run --cwd apps/server build` writes `dist/bin.mjs`; stop the dev-electron watcher first, see the cross-platform ledger "Validation side effect"); exactly one backend (lock file shows one PID); native `opencode` 2.0.29 running (registration file version and `server.info.version` agree); Location `/Users/youpele/DevWorld/bigbud` (not `~/Documents`, which hits TCC EPERM; deferred D7).
3.2 Steps: Settings → Providers → OpenCode: enable, acknowledge **Trust native service execution** (expanded `managed-thread-tools-v2`); wait for **Show detected setup** to report `ready` for the project Location and its parent; confirm the provider card shows green "ready" without the "qualification is incomplete" suffix; new OpenCode chat, connected native model (not a free-tier Big Pickle model; deferred D3); prompt that asks the model to call `bigbud_thread_v1_get_thread_status` and `bigbud_thread_v1_create_thread` for a child task; observe child thread creation; while the child runs, **Stop** the parent turn; after stop, send a second short message to the parent; finally `bigbud_thread_v1_rename_thread` on the child.
3.3 Evidence (redacted): `~/.bigbud/dev/logs/server.log` and `~/.bigbud/dev/logs/provider/events.log` excerpts (paths from `startup/config.ts`), the hold-reason status lines from 2.2 (expected: none persisting beyond 30 s), signed receipt count read through a bounded SQLite read on a fresh online backup (never the live DB), settlement release observed (next send accepted), and `thread-tools:native-qualification:check` output from the same build.
3.4 If any step fails: stop, record the finite stage/errno diagnostics introduced in the cross-platform follow-up, do **not** retry setup or replay prompts, return to Phase 2 with the new evidence.

Exit criteria (G3): ledger `docs/validation/opencode-v2-live-turn-<date>.md` with the step table, timestamps, redacted evidence, model/provider used, and the statement "zero `prior physical admission remains owned` errors".

### Phase 4: Cleanup, amendments, docs, deferral (Gate G4)

Dependencies: G0–G3 (docs must describe the final state).

4.1 **Retired modules.** For each of `Development.composition.ts`, `ServerManager.ssh.ts`, `ServerManager.ssh.bootstrap.mjs`, `ServerManager.ssh.protocol.ts`, `ServerManager.ssh.tunnel.fixture.mjs`, `Coding.transport.ts`, `Application.targets.ts`, `Application.config.ts` (all under `apps/server/src/provider/Layers/OpencodeV2/`): run `grep -rln "/<name>\"" apps/server/src apps/server/scripts` and classify importers. Known importers today: `Application.fixture.ts` (hub), `Development.security.test.ts`, `Development.deadline.test.ts`, `Development.integration.native.test.ts`, `ServerManager.retail.isolation.test.ts`, `ServerManager.ssh*.test.ts` (7), `Coding.plugin.ssh.upgrade.test.ts`, `Coding.transport.test.ts`, `Coding.plugin.upgrade.test.ts`, `Coding.native.test.ts`, `Execution.bridge.test.ts`, `Runtime.policy.admission.test.ts`, `Remote.integration.test.ts`, `Application.config.test.ts`, `Runtime.boundaries.test.ts`. Rule: delete tests that exist only to exercise a retired module; for tests that cover live code through a retired helper, migrate them to `Application.targets.shared.ts` / the shared fixtures and keep their assertions; refactor `Application.fixture.ts` to drop private/SSH factories; in `ServerManager.retail.isolation.test.ts` drop only the `"ssh"` case. Never reduce coverage of live shared paths; record before/after test counts. Also delete the `BIGBUD_OPENCODE_V2_PROFILE_ROOT`/`_WORKSPACE`/`_BINARY` env reads that become dead. Prove: `bun typecheck`, full V2 suite.
4.2 **Lint warnings** in `apps/server/src/provider/Layers/OpencodeV2/**` and contracts `settings.opencodeV2*`: `bunx oxlint --report-unused-disable-directives apps/server/src/provider/Layers/OpencodeV2 packages/contracts/src/core` must print 0 warnings for those paths.
4.3 **Amend stale acceptance criteria by dated addenda (append, never rewrite):** `docs/plans/2026-09-29-opencode-v2-provider-implementation-plan.md` — "Amendment 2026-10-<dd>": AC2 (V1/V2 coexistence) superseded by shared-only/read-only legacy and AC3 (owned authenticated process) superseded by borrowed shared daemon with logical bindings (migration 127); the retired 10-10/10-09 plans' current contract is preserved in [consolidated adoption/setup decisions](../reports/providers-opencode-v2.md#consolidated-adoption-and-setup-decisions); D8 (full macOS/Windows/Linux/SSH scope) narrowed to macOS ARM64 shared-service with Windows/Linux deferred (this plan). `docs/plans/2026-10-09-opencode-v2-owned-deletion-design.md` — Status stays Draft; add "Deferred, see gap-closure plan D5". `docs/plans/2026-10-14-opencode-v2-contract-compatibility-plan.md` — addendum linking the G1/G3 ledgers and setting Status to Implemented only after those gates pass. The automatic-setup plan was later retired; update its consolidated contract in `docs/reports/providers-opencode-v2.md` rather than recreating the old plan or implying source implementation proves qualification.
4.4 **CHANGELOG.** `docs/CHANGELOG.md` v0.3.0: replace "xx October, 2026" with the release date when known; add "### OpenCode, using your own service" with user-facing bullets in the existing bold-lead style: connect to the running OpenCode 2 service without a second sign-in; one-time trust acknowledgement; automatic setup of bigbud's thread tools so the agent can create, message, check, list and rename bigbud chats; interrupt and resume safely; what is not supported (Windows/Linux native execution, free-tier models that return 403, 10 MiB images).
4.5 **Provider report.** Update `docs/reports/providers-opencode-v2.md`: replace the "current working registry is empty" sentence with the 2.0.29 darwin/arm64 record and ledger link; state the instance lock; state that unqualified releases still run with amber disclosure; keep all security/limit wording.
4.6 **Named follow-up for deferred work.** Create `docs/plans/2026-10-<dd>-opencode-v2-windows-linux-native-qualification-plan.md` (Status: Deferred) containing the Deferred work table below verbatim.

Exit criteria (G4): rerun the Phase 0.5 command series on the final SHA; ledger `docs/validation/opencode-v2-gap-closure-final-<date>.md` asserting every Definition of Done item with evidence links; independent top-level reviews (code, security, requirements) recorded with session IDs. Then set this plan's Status to Implemented and write `Implementation/Plan green: YES (macOS ARM64 shared-service scope)`.

## Deferred work (owner / trigger)

| ID  | Item                                                                                                                               | Owner                                   | Trigger to reopen                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Windows native execution and publication (socket `DuplicateHandle`, `GetMappedFileNameW` metadata, real reboot/hibernation, ARM64) | Follow-up plan 4.6                      | A Windows x64/ARM64 run of `.github/workflows/opencode-v2-shared.yml` with a 2.0.29 fixture and an approval record for `win32` (requires widening `V2NativeIsolationApproval.platform`) |
| D2  | Linux native installation/execution                                                                                                | Follow-up plan 4.6                      | `ubuntu-24.04` job with a `linux/x64` approval record                                                                                                                                   |
| D3  | Big Pickle free-tier HTTP 403 vendor predicate                                                                                     | Provider maintainers                    | Upstream documents free-tier limits, or a second user report; fix is a `Catalog.native.ts` availability predicate marking such models `requires-setup`                                  |
| D4  | 10 MiB native media HTTP 500 (upstream) and non-atomic recursive delete                                                            | Upstream OpenCode                       | Upstream release notes a fix; keep the stress probe excluded until then                                                                                                                 |
| D5  | Explicit owned native-history deletion gate (10-09 design)                                                                         | Product decision + provider maintainers | User confirms D7 "explicit deletion removes owned native history when safe" and upstream exposes a conditional delete                                                                   |
| D6  | Reboot-recovery receipt outcome "unknown" after `st_dev` change                                                                    | Provider maintainers                    | Next user-initiated reboot with Phase 2.2 diagnostics in the build; resolve via `RebootRecovery.*` evidence, never by deleting the receipt                                              |
| D7  | `~/Documents` Location EPERM (macOS TCC, HTTP 500 empty body)                                                                      | Desktop maintainers                     | Decide between requesting Full Disk Access in the desktop shell and documenting the limitation                                                                                          |
| D8  | Promotion of future OpenCode releases (version drift policy)                                                                       | Provider maintainers                    | Each new stable release the user installs: rerun Phase 1 (workflow dispatch with the new version, new approval record, new evidence packet); never relabel an old record                |

## Risks And Decision Gates

- **Never drop migration 127 / `OpencodeV2SharedBindings`.** Rollback of any phase keeps the table, rows, creation intents, cursors, journals and receipts (provider report "Disable and rollback"). Rollback = disable the provider through settings, not schema changes.
- **Registry promotion is metadata-only.** Guaranteed by the generator closure excluding the registry; G1 checks `generatorSourceDigest` unchanged. If it changes, stop: a bootstrap byte change is a breaking activation and needs the stable-bootstrap plan's replacement path.
- **Hosted runner acceptance (A3) is a product/security decision.** If rejected, Phase 1 waits for a local VM; nothing else blocks. Egress on hosted runners is only loopback-restricted by the `pfctl` step; record it as evidence, not attestation.
- **Instance lock may break a two-backend dev habit.** Mitigation: explicit error naming the owning PID/port and the `BIGBUD_HOME` alternative; verify `bun dev`/`bun dev:desktop` flows before merging.
- **H1 may be wrong.** Phase 2 is observability-first; the ledger must state confidence. No settlement release may be timer-based.
- **Deleting retired modules can remove coverage of live code.** Phase 4.1 rule and before/after counts guard this; `ServerManager.retail.isolation.test.ts` keeps the private/shared/version-helper refusal cases.
- **Billed live turn.** Phase 3 costs money and touches the user's native history; it is user-operated, single attempt per failure, no replay.
- **Commit split.** Each staged group must typecheck on its own; if the Effect patch and server changes are inseparable, merge groups 1 and 4 and note it.

## Testing And Validation

Per phase above. Repository-level commands (sequential, from repo root): `bun fmt:check`, `bun lint`, `bun typecheck`, `bun run test`, `cargo fmt --all --check`, `cargo clippy --locked --workspace --all-targets -- -D warnings`, `cargo test --locked --workspace`. Focused server runs use `bun run --cwd apps/server vitest run <files>`; browser checks for the setup UI use `bun run --cwd apps/web test:browser src/components/settings/ProviderThreadToolsSetup.browser.tsx src/components/settings/ProvidersSettingsSection.nativeTrust.browser.tsx src/components/chat/provider/useOpenCodeRuntimeSetup.browser.tsx`. Contracts: `bun run --cwd packages/contracts test`. Native scopes run only on the approved runner. Every ledger records commands, exit codes, durations, skip counts and the SHA; failures that are unrelated or blocked are recorded, not hidden.

## Acceptance Criteria

The seven Definition of Done items, each cross-referenced from `docs/validation/opencode-v2-gap-closure-final-<date>.md`, plus: this plan's Status updated to Implemented; the follow-up plan file for D1/D2 exists; no file added or materially edited exceeds 400 lines.

## Open Questions

1. Does the user accept GitHub-hosted `macos-15` ephemeral runners as the approved clean macOS ARM64 environment (A3), or require a local VM?
2. Is `2.0.29` the release to promote, or should the user first upgrade to a newer stable (D8 then applies immediately)?
3. Should a Kanban card be created to track the deferred table (none exists today)?
4. Instance lock strictness: refuse (recommended) or warn-only when a second backend targets the same state directory?

## Amendment 2026-10-15 (implementation findings)

Appended after Phases 0–2 and the Phase 1 code preparation. Earlier text is unchanged. Ledgers:

- [Consolidated Phase 0](../validation/opencode-v2-gap-closure-final-2026-10-15.md#consolidated-setup-and-stabilization-checkpoints)
- [Phase 2](../validation/opencode-v2-live-send-diagnosis-2026-10-15.md)
- [Phase 1 preparation](../validation/opencode-v2-native-qualification-2.0.29-2026-10-15.md)

Recorded decisions: instance lock refuses; GitHub-hosted `macos-15` is used for code preparation (A3 still awaits the user's acceptance); 2.0.29 is the release to promote.

### B1: §1.2 mapping corrected (suite v1 → v2)

Twelve v1 files launched through the private owned-process launcher. That path is `ServerManager.fixture.ts` / `Application.fixture.ts` → `startOwnedV2Process` → `assertDevelopmentVersion`, which accepts only CLI 2.0.26, so these files could never pass against a 2.0.29 image. The private path is also not the production path (non-goals: shared-only).

Each file was resolved individually:

- **PORT:** the file keeps its assertions and obtains its native service only through the approval-gated `sharedServiceNativeFixture`, borrowed through the production manager `start`.
- **EXCLUDE:** the file only exercises a retired path, or a named shared-path file in the same scope covers it. Excluded files are Phase 4.1 retirement candidates, except `Catalog.native`.

| File                             | Decision | One-line justification                                                                                                                                                     |
| -------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime.native                   | PORT     | Only native Runtime evidence for `failed`/`interrupted` outcomes, 25-owner capacity and idempotent learning review on a borrowed transport                                 |
| Runtime.permissions.native       | PORT     | Only native evidence that a reject closes every pending request and that saved native grants block send and resume (gate active on the shared path)                        |
| Runtime.accessModes.native       | PORT     | Only native evidence that all three access modes enforce real native policy on the shared application. The bounded edit uses native `write`                                |
| Runtime.deletion.contract.native | PORT     | Only native evidence that native removal never cascades into forks or independent sessions (shared history retention)                                                      |
| Runtime.load.native              | PORT     | Only native evidence for 25 simultaneous generating sessions with terminal repair and no replay redispatch                                                                 |
| Runtime.context.native           | PORT     | Only native evidence that instruction revisions survive a native restart and that unsupported forms are cancelled. Restart is proven by `fixture.restart()` plus a new PID |
| Runtime.attachments.native       | PORT     | Only native evidence for image delivery and attachment replay without resend after a native restart                                                                        |
| Runtime.tools.native             | EXCLUDE  | Retired remote-session conformance (`ssh:` workspace target). Shared tool schema is covered by `SharedService.context.native` (moved into this scope)                      |
| Runtime.model.native             | EXCLUDE  | Covered by `SharedService.model.routing.native` (moved into this scope)                                                                                                    |
| Execution.application.native     | EXCLUDE  | Retired isolated coding bridge and seatbelt executor, which the shared adapter omits. Covered by `Orchestration.approval.native` and `Orchestration.production.native`     |
| Execution.lifecycle.native       | EXCLUDE  | Retired contained-executor teardown. Covered by `Runtime.native` and `Orchestration.lifecycle.native`                                                                      |
| Catalog.native                   | EXCLUDE  | Needs public internet. Kept as a separate non-qualification smoke                                                                                                          |

Final v2 mapping (`NativeCompatibility.qualification.suite.ts`, 26 files; every scope non-empty):

- `api-transport-admission`: `SharedService.native`, `SharedService.application.native`, `SharedService.logical.native`, `Runtime.native`.
- `native-tool-schema-catalog-permissions`: `SharedService.context.native`, `SharedService.model.routing.native`, `Runtime.permissions.native`, `Orchestration.approval.native`.
- `isolation-hooks`: `SharedService.native.isolation.test.ts`, `ServerManager.retail.isolation.test.ts` (added), `Runtime.accessModes.native`.
- `rpc-crypto-cancellation`: unchanged.
- `history-receipt-approval-integration`: `SharedService.history.native`, `Orchestration.lifecycle.native`, `Runtime.deletion.contract.native`, `Runtime.load.native`.
- `source-config-autoload`: unchanged.
- `two-location-lifecycle`: `Orchestration.stable.native`, `Runtime.context.native`, `Runtime.attachments.native`.
- `packaged-ab`: unchanged.

The ported files are unexecuted until the runner run, because the developer Mac is ineligible for retail launches.

### B2: egress

A whole-host `sudo pfctl` loopback-only rule would sever a hosted runner's own connection to GitHub. It is replaced by the per-process seatbelt profile `scripts/opencode-v2-qualification-egress.sb`, applied with `sandbox-exec -f` around each scope run. Its SHA-256 is part of the environment and runner evidence. Accepted as evidence, not attestation.

### B3: approval id

`gh-macos-15-arm64-opencode-2.0.29` fails the approval schema `^[a-z0-9-]{1,100}$`. The accepted id is `gh-macos-15-arm64-opencode-2-0-29`.

### B4: trigger

`workflow_dispatch` is only available once the workflow is on the default branch. The job therefore also runs on a push to `task/opencode-v2-qualify-*`; ordinary `task/opencode-v2-*` pushes never run it. After merge it runs on dispatch with `qualification: true`. Accepted.

### Phase 2 departures (accepted as implemented)

- The lock is wired in `server.ts` `makeServerLayer` (`Layer.provide(StateDirLockLive)`, built before `HttpServerLive` and every persistence layer) instead of `serverRuntimeStartup.bootstrap.ts`.
- A dead owner is replaced under an exclusive `backend.lock.takeover` mutex plus a fresh exclusive create, not temp + rename, because rename-over is non-exclusive.
- Startup refuses (fails closed) when the owner's start time is unreadable or missing, so PID reuse cannot be ruled out (for example on Windows).

### Corrected V2 totals

The plan's "1,048 pass / 286 files" used a different selection. The focused `src/provider/Layers/OpencodeV2` run measured the following:

| Run                    | Files                         | Tests                         |
| ---------------------- | ----------------------------- | ----------------------------- |
| Phase 0                | 254 (217 passed / 37 skipped) | 948 (898 passed / 50 skipped) |
| Phase 1 preparation    | 256 (219 / 37)                | 974 (924 / 50)                |
| Suite v2 (B1 resolved) | 256 (219 / 37)                | 975 (925 / 50)                |

The 50 skips break down as:

- 47 in the 37 `*.native*` files, expected without an approval record;
- 3 platform-gated: `Development.security.test.ts` and `SharedService.packaging.test.ts` (win32 only), and `RebootRecovery.host.linux.test.ts` (Linux only).

### Open follow-ups

- The CLI maintenance commands do not take the state-directory lock.
- `bun dev:server` crashes under Bun 1.3.14 on a static `node:sqlite` import in the Cursor `Provider.usageLimits.credentials.ts` (commit `bbb65462ca`). This is pre-existing and unrelated to this plan.
- Phase 4.1: retire the four retired-path excluded files (`Runtime.tools`, `Runtime.model`, `Execution.application`, `Execution.lifecycle`). Keep `Catalog.native` as a smoke, or port it to the shared path if a public-network job is ever approved. Drop the `ssh` case in `ServerManager.retail.isolation.test.ts`.

### Independent review findings (Leg 7, appended 2026-10-15)

These change plan-level semantics; earlier text is kept as written.

- **Phase 2.1 lock identity.** Owner liveness now uses a versioned, environment-independent start token (`start-v2:`; Linux `/proc/<pid>/stat` field 22 plus boot id, other POSIX `ps lstart` under `LC_ALL=C TZ=UTC`). Only two comparable tokens that differ prove PID reuse. Locks written by older builds fail closed unless the owner PID is gone. Another host's lock is refused with a message naming that host. The remote-agent controller uses the same comparison.
- **H1 receipt evidence.** "Durable receipt" now means a `completed` receipt, or a `reserved`/`absent` receipt while no canonical handler or dispatch for that invocation is in flight in this server process (in-process ledger `threadToolInvocationFlights.ts`). A dispatch abandoned before the route started it is fenced and refused on arrival. There is still no timer.
- **Phase 1 assembly.** Each scope report must have run exactly its frozen suite file set.
- Settlement diagnostics log through the server's own logger and level.

Evidence: [live-send diagnosis](../validation/opencode-v2-live-send-diagnosis-2026-10-15.md) "Independent review fixes" and [qualification ledger](../validation/opencode-v2-native-qualification-2.0.29-2026-10-15.md) "Leg 7".
