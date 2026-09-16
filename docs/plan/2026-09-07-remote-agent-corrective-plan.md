# Remote agent independent-review corrections

**Date:** 7 September, 2026
**Status:** Implemented within supported provider boundaries — final validation and parent independent review pending
**Owner:** implementing agent; parent owns independent review

## Summary

Integrate the existing isolated-update implementation, correcting all ten reported defects without shared-state takeover. No staging, commits, production access, publication or fixture authenticity claims.

## Related Work

- [Approved isolated update plan](2026-09-07-remote-agent-isolated-update-plan.md)
- [Protected historical investigation](remote-agent-0.2.205-upgrade.md)
- User-supplied independent requirements review (11 Linux passes, one failure). No note/card identifier supplied.

## Problem

Successive admission currently validates a half-published selector. Durable owner pruning can erase replay evidence, public tools omit invocation identity, and Git substeps can select different generations. Availability failures and historical readiness are also misclassified.

## Goals

Stage without starting; deliberate fresh admission validates isolated readiness before work; original work stays pinned across restart; retain two healthy builds plus live/recovery references; classify build faults separately from transport uncertainty; show explicit fallback.

## Non-Goals

Shared legacy takeover, journal import, SSH/VPS, release operations, dependencies, or unrelated cleanup.

## Current State

Reuse registry CAS/validated reducers, SQLite owner reservations, owned process/PTY/workspace runners, existing Effect schemas and dot-notation modules. `remoteAgentAdmission.ts:325-338` calls a validating promotion before publishing the connection. `RemoteAgentRuntimeBindings.ts:30-40` deletes terminal evidence. Existing Linux Docker harness supports network-disabled actual saved binaries. Existing modified work is preserved.

## Phases

Each item tracks a finding and its required regression, not merely a primitive. The ten original findings are implemented; the independent-review corrections below record the provider boundary and final validation still required.

- [ ] 1: Atomic promotion: extend the promotion reducer with admission/connection publication in the same validated CAS; successive distinct builds and fallback through real admission tests/Linux production test.
- [ ] 2: Stable public tool identity: propagate originating invocation through provider/HTTP/transport to owned runner before resolution; lost reply plus restart executes once, distinct actions stay distinct.
- [ ] 3: Replay fence: bounded durable expired-identity evidence must survive terminal pruning and reject expired retries; unknown owners remain retained. Exercise SQLite pruning and side-effect retry.
- [ ] 4: Whole Git action: persist action-level route before substeps, reuse for commit/push/retries and queued work; activate between substeps and restart.
- [ ] 5: Death reconciliation: preserve historical admission epoch while permitting matching proven-dead launch; test actual supervisor exit and cleanup with recovery pins.
- [ ] 6: Stage classification: wrap only successfully received invalid check output as definitive; SSH/auth/network errors retain reservation and eligibility; fault tests.
- [ ] 7: Predispatch rollback: include remote pin and local dispatch-state writes in conditional rollback; preserve uncertain refs and permit proven-unsent retries; fault each boundary for process/PTY/write.
- [ ] 8: Legacy compatibility: restrict version alias to recognized legacy evidence, exact comparison otherwise; recognized source fixture is continuity evidence, never signed release authenticity. Test lookalikes.
- [ ] 9: Explicit UI: bounded persisted admission outcome/build/failure metadata in summary/RPC; no version-string inference; same-version fallback and reload browser test.
- [ ] 10: Split both oversized GitCore modules by concern and inspect line counts of ALL modified/untracked source/test files, not only lint-selected tests.

## Risks And Decision Gates

Local SQL and remote registry are separate durability domains: uncertainty must leak pins rather than replay work. No lower-level green fixture substitutes for public-path tests. Existing source-built aarch64 fixtures are not authenticated published artifacts. Parent review remains mandatory; absence of delegation is not a blocker.

## Testing And Validation

Run targeted regressions then `bun fmt`, `bun lint`, `bun typecheck`, `bun run test`, `cargo fmt --all --check`, `cargo clippy --locked --workspace --all-targets -- -D warnings`, `cargo test --locked --workspace`, and `git diff --check`. Run focused browser same-version fallback. Run network-disabled Docker application integration with legacy `461b7865cd28bb2570d9f580405fa53daee7b51f` and candidate base `1d02e44cd090cc0e2bce25a2cca1a88442e4873e`, original stale and retention-expired journals, independent stdio, and single-execution markers. Disclose x64 gaps. Record exact commands/counts/failures below.

## Acceptance Criteria

All ten checks complete, required checks pass, every edited source/test <=400 lines, actual Linux application matrix passes, public restart and browser coverage verified, parent independently reviews. No files staged.

## Open Questions

No product clarification required. Implementation/validation gaps must be reported, not treated as permission blockers.

## Execution Evidence

- Discovery: existing task-owned stopped containers and saved aarch64 binaries found in the approved temporary directory; no production access.

### Corrective implementation status

Historical first-pass status: this was **not a completed end-to-end acceptance claim**. The continuation results at the end of this document supersede the remaining-work column and the earlier outstanding-work list.

| Finding | Applied change and evidence                                                                                                                                                                                                                                                                                                                        | Remaining acceptance work                                                                                                                                                                                                                            |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Promotion reducer publishes selector, admission epoch and connection in one validated CAS. Successive-build test and actual Linux production promotions/fallback pass.                                                                                                                                                                             | Parent review.                                                                                                                                                                                                                                       |
| 2       | HTTP requires an invocation ID, scopes it to authenticated thread identity, and transport forwards it. Pi forwards tool-call IDs with distinct substep suffixes; Copilot forwards session/tool-call identity. Restart test now enters the actual HTTP handler and public transport before owned execution.                                         | Generic MCP bridge still generates a UUID when originating metadata is absent. This does **not** solve provider replay across bridge restart. Other internal tool callers and provider filesystem paths still need a complete stable-identity audit. |
| 3       | Migration 112 adds fixed-capacity monotonic replay evidence; pruning and recording evidence share a SQL transaction. Expired owner retries and superseded invocation IDs in reused terminal owner slots reject. Unknown routes remain retained.                                                                                                    | Actual Linux side-effect-after-pruning public-path test remains absent. Fixed-size evidence can conservatively reject new identities as it fills; never clear it to restore availability.                                                            |
| 4       | Stacked actions reserve a durable whole-action route before initial status; an Effect service supplies it to remote Git owned execution. Completed actions release their action pin after durable terminal publication. SQLite-backed stacked-action test changes selection between commit/push, reopens store and verifies all routes remain old. | Test uses mocked Git step implementations, not real commit/push. Other multi-step Git entry points and queue admission boundaries need full audit/application validation.                                                                            |
| 5       | Historical ready admissions accept their matching proven-dead launch epoch. Actual Linux supervisor is terminated via verified socket peer pidfd; reconciliation preserves admissions and a recovery pin.                                                                                                                                          | Full third-build cleanup-after-death matrix remains to expand.                                                                                                                                                                                       |
| 6       | Only successfully received invalid check output is wrapped as definitive. Unclassified SSH/auth/network failures preserve staging eligibility and ambiguous reservation. Three fault regressions pass.                                                                                                                                             | More received-nonzero-check/transport-loss boundary coverage desirable.                                                                                                                                                                              |
| 7       | Process/PTY/write pin and publication operations are inside conditional rollback handling. Process no longer equates workspace-open dispatch with process dispatch. Fault tests cover pin failure and local publication failure for all three owners, including proven-unsent retry.                                                               | Add lost acknowledgement after committed local publication and remote pin publication tests. Uncertain remote pins are intentionally retained.                                                                                                       |
| 8       | Legacy version alias requires the recognized legacy source build digest in addition to exact hello/check metadata. Lookalikes with arbitrary matching digest reject; exact unrecognized versions remain supported.                                                                                                                                 | Source identity remains continuity evidence only. No published legacy artifact authenticity certification.                                                                                                                                           |
| 9       | Persisted bounded outcome/requested build/failure code maps through summary and connect RPC. UI uses explicit outcome, not version inequality. Same-version fallback survives component reload verification without fresh admission.                                                                                                               | Full browser suite was not run; focused tests only.                                                                                                                                                                                                  |
| 10      | Split GitCore execution contract and remote-operation cache; reused existing target guard module. All changed/untracked source/test line counts inspected, none >400. Layer GitCore=398, service GitCore=390.                                                                                                                                      | Recheck after subsequent edits.                                                                                                                                                                                                                      |

### Exact successful validation commands

From repository root (2026-09-07):

```sh
bun fmt
bun lint
bun typecheck
git diff --check
bun run test
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
git ls-files -m -o --exclude-standard -z | xargs -0 rg --count '^'
bun run --cwd apps/server vitest run src/remote-agent/remoteAgentGit.action.test.ts src/git/Layers/GitManager.stackedAction.commitPush.test.ts src/remote-agent/remoteAgentOwners.restart.test.ts src/remote-agent/remoteAgentOwnedResource.failures.test.ts
bun run --cwd apps/web test:browser src/components/sidebar/SidebarRemoteAgentStatus.browser.tsx src/components/sidebar/SidebarRemoteAgentInstallDialog.browser.tsx src/components/sidebar/SidebarRemoteProjectDialog.upgrade.browser.tsx
BIGBUD_TEST_LINUX_DOCKER=1 BIGBUD_TEST_AGENT_FIXTURES=/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode bun run --cwd apps/server vitest run src/remote-agent/remoteAgentUpgrade.production.linux.test.ts src/remote-agent/remoteAgentInstall.registry.linux.test.ts src/remote-agent/remoteAgentUpgrade.legacy.linux.test.ts src/remote-agent/remoteAgentInstall.cleanup.linux.test.ts src/remote-agent/remoteAgentRuntime.launch.linux.test.ts
```

- Final fmt/lint/typecheck/diff check passed. Lint: four existing warnings, 29 existing oversized-test warnings outside the changed set; no errors. Typecheck: nine successful tasks.
- Final full Vitest run passed: server **2,833 passed / 24 skipped** (684 passing files, eight skipped); web **1,991**; contracts **152**; shared **181**; desktop **328 / four skipped**; scripts **77**; mobile-web **66**. Total **5,628 passed / 28 skipped**. Turbo nine successful tasks (two cached build tasks), 8m25.775s. Log: `/Users/youpele/.local/share/opencode/tool-output/tool_07b47c069001jP5tSexJL0yJWc`.
- Focused action/HTTP-restart/predispatch run: **19 passed**, four files. Final full suite includes the subsequently added reused-owner replay regression.
- Focused browser: **five passed**, three files; same-version fallback/remount included. This is not full browser-green evidence.
- Final network-disabled Docker aarch64 run: **13 passed**, five files, no skips, 48.95s. Saved source-built 0.2.205/0.2.207 fixtures used. Production test now includes real death reconciliation; original production promotion failure passes.
- Rust host gates passed: desktop-supervisor unit 39, watchdog one, cross-language two; protocol six; remote-agent unit 81 and integration two; workspace-watch 21. **152 top-level tests passed** (plus an internal one-test subprocess invocation). These macOS Rust checks do not execute Linux-only Rust preparer tests.
- No x86_64 fixture validation performed. No new source-build/release authenticity claim.

### Failed/intermediate validation, subsequently corrected

- First targeted admission/install-manager run: 11 passed, one failed because the old injected check-failure fixture threw an unclassified Error. Fixture now explicitly throws the definitive type; three availability regressions were added.
- First Linux run after migration-test changes: seven passed and one suite failed to load due to missing Effect import. Corrected; final five-suite Linux run passes.
- Targeted remote-agent/HTTP/bridge run: 282 passed, 21 skipped, two old HTTP fixtures failed because they omitted the newly required invocation identity. Updated fixtures; full final suite passes.
- First full `bun run test` attempt hit the tool's 120-second timeout. Reran with a 600-second bound.
- Next full run: server 2,830 passed, 24 skipped, one failed mocked Git identity test because it had no durable owner store. Kept that fixture scoped to mocked identity behavior and added a separate durable-action SQLite restart test. Final full suite passes.
- Intermediate typechecks caught missing Effect import, a mock returning undefined instead of a workspace response, and a mock returning undefined instead of nullable composition. Corrected; final typecheck passes.

### Corrective files authored or additionally edited in this pass

Paths under `apps/server/src/`:

- `git/Layers/GitCore.ts`, `GitCore.target.ts`, `GitCore.remoteOps.ts`, `GitManager.runStackedAction.ts`, `GitManager.stackedAction.commitPush.test.ts`; `git/Services/GitCore.ts`, `GitCore.execution.ts`.
- `persistence/Migrations.ts`, `persistence/Migrations/112_RemoteAgentReplayFence.ts`, `persistence/Layers/RemoteAgentRuntimeBindings.ts`, `RemoteAgentRuntimeBindings.replay.ts`.
- `remote-agent/remoteAgentAdmission.ts`, `.test.ts`; `remoteAgentInstall.registry.ts`, `.transitions.ts`; `remoteAgentCompatibility.ts`, `.test.ts`; `remoteAgentInstallManager.ts`, `.test.ts`.
- `remote-agent/remoteAgentOwnedProcess.ts`, `remoteAgentOwnedPty.ts`, `remoteAgentWorkspaceMutation.ts`, `remoteAgentOwnedResource.failures.test.ts`; `remoteAgentOwners.race.test.ts`, `.restart.test.ts`, `.httpFixture.ts`.
- `remote-agent/remoteAgentGit.ts`, `.action.ts`, `.action.test.ts`; `remoteAgentStatus.ts`; `remoteAgentUpgrade.production.linux.test.ts`.
- `tool-transport/toolTransport.ts`; `ws/http.threadTools.schema.ts`, `http.threadTools.remoteWorkspace.ts`, `.test.ts`, `wsRemoteAgentAdmission.ts`.
- `provider/Layers/Pi/PiRemoteWorkspaceBridge.template.ts`, `provider/Layers/Copilot/CopilotRemoteWorkspaceBridge.ts`, `remote-workspace-bridge/remoteWorkspaceMcpBridge.template.ts`.

Other paths: `packages/contracts/src/server/server.ts`; `apps/web/src/components/sidebar/SidebarRemoteAgentStatus.tsx`, `.browser.tsx`; this corrective plan. Inherited edits were retained, including Rust journal hardening, with no new Rust source edits in this pass.

### Outstanding work, not an external permission blocker

1. Finish originating stable invocation identity for generic MCP provider restart/replay; do not mistake generated UUIDs or transport request IDs for that identity.
2. Finish the original stale-unmatched AND retention-expired journal **application staging/admission** matrix, independent legacy stdio before/during/after, and public real-process lost-reply/restart/pruning single-execution traces. Existing fresh-state Linux tests do not substitute for these.
3. Complete whole-action route audit beyond stacked commit/push and ambiguous-write acknowledgement fault coverage.
4. Parent independent review is pending. No delegation tool was available, but this did not prevent writing code or running Docker.
5. No staging/commits/pushes/tags/releases/SSH/VPS actions occurred. Task-owned test containers were removed by their fixture cleanup; historical stopped containers remain preserved.

## Continuation completion and acceptance (2026-09-07)

The implementation and requested corrective acceptance work are complete within the explicit supported-operation boundaries below. Parent independent review is next, not an implementation/delegation blocker. This section supersedes the historical outstanding-work list above.

### Completed follow-up work

- **MCP stable identity / non-replayable ambiguity:** removed the random UUID fallback completely. A remote MCP tool call must carry the originating identity in `_meta['bigbud/toolInvocationId']`. Missing/invalid identity returns `REMOTE_INVOCATION_IDENTITY_REQUIRED` before any HTTP or remote frame, including after bridge restart. No content-based deduplication or transport-request-ID substitution. A spawned-bridge test uses separate Node processes, repeats missing identity (zero HTTP calls), repeats the same real identity (same forwarded ID), then uses a distinct identity with identical command text (distinct forwarded ID).
- **Compatibility consequence, explicit rather than hidden:** an upstream MCP client that does not supply an originating stable identity cannot execute these remote tools. It gets the concise non-replayable error. Pi and Copilot supply their SDK tool invocation identities through their existing dedicated paths. This is the user-approved fail-closed alternative, not a claim that unsupported upstream identity recovery exists.
- **Whole-action Git coverage:** all 17 public GitCore mutation entry points are wrapped at the production remote-agent service boundary. Object-input branch/worktree/upstream/remote mutations and positional commit/push/pull/fetch/discard/prepare-commit operations reserve one durable action route before their substeps. Nested stacked-action steps reuse the outer route. Remote RPCs without an originating operation identity fail before work rather than generating a server-side ID. A table-driven SQLite test covers all 17 mutation methods and changes selection between their substeps.
- **PR audit result:** remote PR preparation, `create_pr`, and `commit_push_pr` are deliberately unsupported by the existing GitManager public API and already fail before reaching the local-only helpers/GitHub CLI. Added a public-manager regression confirming that fence. No accidental remote enablement or speculative GitHub transport was introduced.
- **Shared status-refresh cache:** discovered and closed an additional route-loss boundary: cached lookup effects do not carry an action's request-local service context. Pinned mutations now use existing tracking refs instead of entering the independently cached observational upstream refresh. Unrelated observational status refresh remains unchanged.
- **Original legacy journal application transitions:** extended the actual production install/admission suite to fresh, unmatched `Accepted+Started`, and retention-expired `Accepted+Started+Retention(expires_at=1)` histories. Both historical journals are written by the original legacy `OperationJournal`, linked from the saved exact-source legacy release library—not hand-encoded approximations or candidate writers.
- **Concurrent legacy work:** the supervisor process and a separately launched legacy stdio process both have work held by an explicit fixture release-file barrier until candidate admission completes. The independent stdio endpoint is exercised before, during, and after activation, with exactly `before during after ` marker content. The original live operation produces exactly one `marker`, then completes after release. Old discovery remains unchanged; staging preserves old journal hash; candidate admission preserves the legacy-owned on-disk epoch. The test accounts for the legacy stdio session's own expected epoch rotation, rather than incorrectly attributing it to candidate activation.
- **Real public-path replay/pruning:** added a local HTTP loss harness entering the production `runRemoteWorkspaceProcess` handler, actual public tool transport, durable owned runner and real Docker legacy supervisor. A response is deliberately destroyed after execution; SQLite store and connection pool are reconstructed; a candidate is staged/admitted; retry remains on the original connection with one marker. After 260 terminal fixture owners force pruning of the original row, the old originating ID gets HTTP 502/expired with still one marker. A distinct originating ID with identical command produces the second marker. This is application-service reconstruction, not a claim of booting a second complete packaged desktop/server process or testing external provider infrastructure.
- **Ambiguous publication:** added lost-CAS-reply-after-coherent-admission-commit recovery, local dispatch-state commit/lost acknowledgement (retry attaches only), and remote pin commit/lost acknowledgement for process, PTY and workspace write. Existing before-publication failure coverage exercises all three owner types. Durable ambiguous pins/fences survive; no retry dispatch is authorized by acknowledgement loss.

### Final acceptance matrix actually executed

| Case                                                                                         | Actual result                                                                             |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Fresh legacy journal → staged candidate → deliberate admission                               | Passed using original 0.2.205 and candidate 0.2.207 source-built aarch64 binaries         |
| Original unmatched legacy journal → same production transition                               | Passed                                                                                    |
| Original retention-expired legacy journal → same production transition                       | Passed                                                                                    |
| Independent legacy stdio before/during/after, original live supervisor work across admission | Passed for all three histories; explicit release barrier, no timing-only sleep assumption |
| Successive real healthy promotions, invalid candidate, verified fallback                     | Passed for all three histories                                                            |
| Real supervisor death with historical admissions and recovery pins                           | Passed for all three histories                                                            |
| Public HTTP reply loss + owner-store/pool restart + newer admission                          | Passed; original side effect once                                                         |
| Public retry after terminal owner pruning                                                    | Passed; expired rejection, original side effect still once                                |
| Identical command under a distinct originating invocation                                    | Passed; separate execution, no content dedup                                              |
| MCP missing identity across bridge process restarts                                          | Passed; zero remote dispatch                                                              |
| MCP same/distinct originating identity propagation                                           | Passed                                                                                    |
| 17 logical Git mutation methods, selection between substeps                                  | Passed with SQLite ownership and method fixtures                                          |
| Remote PR preparation/creation unsupported boundary                                          | Passed; no repository execute call                                                        |
| Local/remote pin publication uncertainty and admission CAS lost reply                        | Passed in targeted/unit suites and included in full Vitest run                            |
| Same-version UI fallback and remount verification                                            | Five focused browser tests passed; full browser suite not claimed                         |

### Final commands/results

`bun fmt`, `bun lint`, `bun typecheck`, and `git diff --check` passed after the final source and fixture edits. Lint retained four existing warnings, no errors; the all-changed-source line audit is separate from lint's test-only policy. `git/Layers/GitCore.ts` is exactly 400 lines; every changed/untracked source/test file is <=400.

`bun run test` passed: **5,636 tests passed / 35 skipped** across packages; server **2,841 passed / 31 skipped** (687 passing files, nine skipped); web 1,991; contracts 152; shared 181; scripts 77; mobile-web 66; desktop 328/four skipped. Nine Turbo tasks succeeded (two cached build tasks), 8m34.964s. Log: `/Users/youpele/.local/share/opencode/tool-output/tool_07b66336c001riDIN7jM8eGgDi`. The final release-barrier strengthening only changes Linux-gated tests, which were rerun afterward with actual fixtures.

```sh
BIGBUD_TEST_LINUX_DOCKER=1 BIGBUD_TEST_AGENT_FIXTURES=/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode bun run --cwd apps/server vitest run src/remote-agent/remoteAgentUpgrade.production.linux.test.ts src/remote-agent/remoteAgentUpgrade.public.linux.test.ts src/remote-agent/remoteAgentInstall.registry.linux.test.ts src/remote-agent/remoteAgentUpgrade.legacy.linux.test.ts src/remote-agent/remoteAgentInstall.cleanup.linux.test.ts src/remote-agent/remoteAgentRuntime.launch.linux.test.ts src/remote-workspace-bridge/remoteWorkspaceMcpBridge.identity.test.ts
```

Final result: **21 passed, seven files, zero skips, 44.35s**. This comprises 20 Docker Linux fixture tests and one host-spawned MCP bridge test. Docker fixture execution is network-disabled. The historical stopped containers remain untouched; the temporary seed-build container and test containers were removed.

```sh
bun run --cwd apps/web test:browser src/components/sidebar/SidebarRemoteAgentStatus.browser.tsx src/components/sidebar/SidebarRemoteAgentInstallDialog.browser.tsx src/components/sidebar/SidebarRemoteProjectDialog.upgrade.browser.tsx
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
git ls-files -m -o --exclude-standard -z | xargs -0 rg --count '^'
```

Browser: **five passed, three files**. All three host Rust gates passed again; **152 top-level tests** plus the internal subprocess test invocation described earlier. No new Rust production edits. Linux-only Rust workspace cases are not counted as host passes.

### Seed provenance and reproducibility

Saved `/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/legacy-journal-seed.rs` uses `bigbud_remote_agent::operations::{JournalRecord, OperationJournal}` to append the original unmatched records and optional expired retention. Built in a disposable network-disabled `rust:1.95-bookworm` container with dependency artifacts copied from `bigbud-upgrade-reviewed-legacy-fixture:/tmp/legacy/target/release/deps/`. The original saved fixture was built from `461b7865cd28bb2570d9f580405fa53daee7b51f`.

Compilation command in that container:

```sh
rustc --edition=2024 /fixtures/legacy-journal-seed.rs --extern bigbud_remote_agent=$(printf "%s" /tmp/libbigbud_remote_agent-*.rlib) -L dependency=/tmp -o /fixtures/legacy-journal-seed
```

The installed image is arm64 (`docker image inspect rust:1.95-bookworm --format '{{.Architecture}}'`). No x86_64 executable/image validation was performed; this remains an explicitly disclosed platform coverage gap, not a reason Linux aarch64 was skipped. Source-built fixtures and disposable test signatures do not establish authenticity of published release binaries.

### Independent-review corrections (2026-09-07)

- **Ordinary MCP providers:** `tools/call` uses explicit `_meta['bigbud/toolInvocationId']` when supplied. Otherwise each production bridge persists a typed provider-session invocation sequence; same-process retries reuse the typed entry, numeric `1` and string `"1"` remain distinct, and a reused request identity after bridge restart fails closed before HTTP dispatch. No content deduplication or generic SDK exactly-once claim is made. The installed provider bridges expose no stronger common originating identity contract.
- **Copilot filesystem callbacks:** the public `@github/copilot-sdk` 1.0.7 `SessionFsProvider` exposes `sessionId` but no per-filesystem-call or `toolCallId` identity (the SDK RPC params contain only session/path/content fields). The bridge persists an atomic per-session sequence in its state root, keeps ordinary first calls working, and marks handler recreation or lost remote acknowledgement as mutation-ambiguous; subsequent mutations fail closed rather than replaying. Reads remain usable. The custom Copilot bash tool continues to use the real SDK `toolCallId`. This is the product-preserving boundary supported by the installed SDK.
- **Managed/custom Git:** managed generation-owned execution is marked separately from external/direct SSH execution. Only managed composition installs durable action wrappers and runtime bindings; custom/direct SSH composition remains usable without managed owner state. Read-only Git status execution bypasses durable owner reservations and the monotonic replay fence.
- **Activation pins:** completed attempt pins are released only after the coherent admission and local connection binding are published. Previous live/uncertain connection references remain pinned. Admission churn now exercises more than the registry admission budget and verifies that only the live connection pin remains.
- **Prepared-owner recovery:** durable owner reservations record controller identity. A prepared owner is reclaimed only when its owning controller PID is proven absent; live controllers remain in progress, and `may-have-been-sent`/terminal owners are never reclaimed by timeout. SQLite race coverage exercises dead-controller recovery and live-controller blocking.
- **Replay evidence:** the replay fence remains monotonic and is never cleared to recover capacity. Observational Git status no longer consumes owner/replay history; false positives remain conservative rejection rather than unsafe redispatch.

### Additional files in the continuation

- `apps/server/src/remote-workspace-bridge/remoteWorkspaceMcpBridge.template.ts`, `.identity.test.ts`
- `apps/server/src/remote-agent/remoteAgentGit.mutations.ts`, `.mutations.test.ts`
- `apps/server/src/git/Layers/GitCore.ts`, `GitStatus.upstream.ts`, `GitManager.remoteBoundary.test.ts`
- `apps/server/src/ws/wsRpcHandlers.gitTerminal.ts`
- `apps/server/src/remote-agent/remoteAgentUpgrade.production.linux.test.ts`, `.public.linux.test.ts`, `.installFixture.ts`
- `apps/server/src/remote-agent/remoteAgentOwners.httpFixture.ts`, `remoteAgentOwnedResource.failures.test.ts`, `remoteAgentAdmission.test.ts`
- The external seed source/binary and this plan; no staged documentation or Git changes.

Intermediate fixture faults were corrected before successful reruns: missing private HTTP-fixture HOME, synthetic `/workspace` differing from `/tmp/workspace`, and a fake-store getter signature mismatch. A leaked container from the failed pre-setup attempt was explicitly removed by its owned ID. No product failure is hidden by those harness corrections.
