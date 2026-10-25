# OpenCode V2 stable-bootstrap working evidence

**Status: partial implementation, not source/release acceptance.** This ledger does not replace historical v2/v3 manifests or claim either completion gate is green.

## Authoritative scope change

During fixture qualification, the executable previously used for 2.0.27 at `/Users/youpele/.opencode/bin/opencode` reported **2.0.28**, with SHA-256 `7d9e936ab23af4928e0dfbf94c9fe313aac0728eef34a06709e1d86ca8987341` rather than its previous `7fa5c8659e57cae76b1da4f45edbc583aef93aae917246a0b3abb1ac1b3fb93c`. No agent CLI upgrade/install was performed. The failed run is not 2.0.27 qualification.

The user then explicitly chose **“Support contract-compatible V2”**, whose presented description was: “Amend the plan for capability/ABI-based V2 minor support instead of an exact-version allowlist; this requires broader compatibility design and tests.” V3 remains rejected. This supersedes the exact-version support policy in the [approved stable-bootstrap plan](../plans/2026-10-13-opencode-v2-stable-bootstrap-maintenance-plan.md). It does not authorize live-native operations or weakening security/lifecycle contracts.

The native-version-policy portion is paused pending an implementation-ready amendment. This child session attempted `planner`, but the tool returned **Subagent depth limit reached (1)**. It did not bypass that limit. Parent-coordinated planning/review must resolve contract/capability validation, qualification evidence, manifest semantics and incompatible-minor handling before changing the version gates. Current source still contains the prior exact-version checks and **does not implement broad V2 minor support**.

## Isolation and provenance

- Primary root: `/Users/youpele/.local/share/opencode/worktree/3cd1dc/opencode-stable-bootstrap`.
- HEAD: `91154fa9c086e1d47a3bbddfea4a8d56a35be44d`; detached HEAD was observed, not an assumed branch name.
- Copied baseline: 229 paths; independently reconciled exact hashes before edits. Baseline file: `stable-bootstrap-isolated-baseline.json`, SHA-256 `3f3f811dc3d246e20947f7a5d615bb46d7031085a9ee93e2094876ea93292e5e`, in the approved temporary directory below.
- Isolated `bun install --frozen-lockfile` completed; workspace contract symlinks resolve into this worktree, not the original checkout.
- No original-root source edits, installs, formatting, builds, native service actions or git publication were performed. No old validation progress/log/status polling occurred.
- One interim root typecheck advertised Turbo's automatic **shared worktree cache** before it failed on a new contracts-test import. This run is excluded from isolated acceptance evidence. The exact cache effects were not inspected or altered in the original checkout. Installed Turbo 2.11.5 docs confirmed `TURBO_CACHE_DIR` disables sharing; all subsequent Turbo commands use the explicit isolated path below and no longer advertise shared worktree caching.
- Native execution used disposable HOME/config/database/service fixtures and synthetic loopback vendors. No actual user-native configuration, account, permission, history or live-service API was accessed.

## Implemented working areas

- Frozen five-tool native schema renderer; immutable pure handler generations A/B with different preparation and interpretation, generated fixed-closure digests, build `--check`, bounded reference registry and signed app-private default selection.
- Handler capture on enrollment/call; strict narrow canonical-body validation, unchanged stable IDs/raw-input fingerprints, preparation after receipt inspection, final interpretation persisted before response, explicit historical/new receipt decoding and reserved uncertainty retention.
- Signed N owner domain `bigbud.thread.enrollment.v2` separate from RPC `bigbud.thread.v1`; bootstrap ABI/implementation/compatibility identity binding; emitted L inspect/detach-only verification with separate tombstones.
- Strict detach acknowledgement validation in both cleanup paths; signed retirement phases retain old evidence and require separate physical/durable proof before replacement. App-private signed per-record writer ownership reuses existing exclusive lock primitives.
- Shared root-injected activation service, separately owned revocable background permits/connections/interests, activity bounds, fixed deadlines, synchronous gates, per-Location epochs and native setup-instance identity.
- Startup/readiness waits before durable binding and outside the namespace queue; new-turn waits outside the session queue; physical reservations retained beyond acknowledgement; control joins/pause and fail-closed callback admission during closure.
- App-private publication boundary closes local admission before initial native-directory/lock writes; final activity check and all-Location epoch invalidation precede link/rename. Physical writer joins outlive cancellation and retain uncertain evidence.
- Signed retained N artifact verification/manual-source reuse; legacy manual entry remediation classification without configuration rewrite or autoload alias.
- Schema-discriminated setup/status/cancel-interest inputs, safe phase/installed-versus-desired fields, bounded passive UI polling, stale-result fencing and revised unchanged-identifier trust disclosure.

These areas are working source, not a declaration that every race/recovery scenario in the plan has been implemented or qualified.

## Working checks

Logs are retained in `/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/` with prefix `stable-bootstrap-v4-`. They are interim evidence, not a final frozen-source run.

| Command                                                                                                                                                                                                                           | Result                                               | Evidence                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                                                                                                                                                                                                   | Passed                                               | `stable-bootstrap-isolated-install.log`; isolated workspace dependencies                                                                                       |
| `bun fmt <explicit changed-scope paths>`                                                                                                                                                                                          | Passed                                               | Authored/materially edited code line audit: zero files over 400 lines                                                                                          |
| `bun run --cwd apps/server thread-tools:manifest` and `thread-tools:manifest:check`                                                                                                                                               | Passed during working checks                         | Generated metadata checked by focused handler tests; must rerun after any frozen-source changes                                                                |
| `bun lint`                                                                                                                                                                                                                        | Passed                                               | `lint-partial2.log`: 50 warnings, zero errors; nine pre-existing oversized-test warnings, no policy violations                                                 |
| `TURBO_CACHE_DIR=/Users/youpele/.local/share/opencode/worktree/3cd1dc/opencode-stable-bootstrap/.turbo/cache bun typecheck`                                                                                                       | Passed                                               | `typecheck-root-isolated-partial-green.log`: 9/9 tasks; no cache hits                                                                                          |
| `bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2`                                                                                                                                                             | Passed                                               | `v2-focused-partial.log`: 158 files / 599 tests passed; 33 files / 44 tests skipped, not native passes                                                         |
| `bun run --cwd packages/contracts vitest run src/server/server.opencodeV2ThreadToolsSetup.test.ts`                                                                                                                                | Passed                                               | `contracts-partial.log`: one file / one test; status/cancellation cannot decode as installing refresh                                                          |
| `bun run --cwd apps/web test:browser src/components/settings/ProviderThreadToolsSetup.browser.tsx src/components/settings/ProviderCard.opencodeV2.browser.tsx src/components/chat/provider/ProviderModelPicker.setup.browser.tsx` | Passed                                               | `browser-partial.log`: three files / five tests                                                                                                                |
| Six owned native lifecycle/stable/setup/production/readiness/approval suites, 2.0.26                                                                                                                                              | Initial expanded run: seven tests passed, one failed | `native-26-expanded-partial.log`; missing-manual-RPC diagnostic was incorrectly surfaced as generic HTTP 404                                                   |
| `Orchestration.readiness.failure.native.test.ts`, 2.0.26, after diagnostic correction                                                                                                                                             | Passed                                               | `native-26-readiness-partial-rerun.log`: one file / one test; no test expectation was weakened                                                                 |
| Same six suites requested as 2.0.27 against the changed installed executable                                                                                                                                                      | Failed/unqualified                                   | `native-27-expanded-interim.log`: actual fixture reported 2.0.28; old guards rejected it. Not evidence of 2.0.27 support or contract-compatible 2.0.28 support |

The retained 2.0.26 executable is `/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/v2-2.0.26-qualification/cli-darwin-arm64/package/bin/opencode`, SHA-256 `1b6418a3bd4211344d8a2b75d7d4367b24283ae548bd6b896cf717f6f8858f26`. Fixture server version is asserted, with no user-service discovery or administration.

The full six-suite 2.0.26 rerun after diagnostic correction passed **six files / eight tests** (`native-26-expanded-working-green.log`). Affected orchestration/setup/startup-wait suites after final plain-JSON boundary checks passed **29 files / 61 tests**, with eight files / 11 tests skipped (`affected-working-final.log`). These remain working checks, not a final acceptance run.

## Required follow-up

Latest follow-up checks: root lint passed (`lint-working-final.log`), isolated-cache root typecheck passed **9/9 tasks** (`typecheck-working-final.log`), and all six owned 2.0.26 native suites passed **six files / eight tests** after the lifetime/foreign-owner changes (`native-26-lifetime-followup.log`). No source acceptance is inferred from these partial checks.

Follow-up source work on 14 October added physical SDK control-promise tracking, inspection-versus-retained-lease validation before detach, Effect RPC-signal binding to each issued interest, verified signed-default diagnostics, pre-enrollment failed-start settlement, and a pre-history guard against unretired foreign owners. The corresponding latest focused run passed **10 files / 18 tests** (`owner-lifetime-followup.log`). A shorter interim server typecheck and grouped test run timed out and were terminated by SIGTERM; these are not passes. A longer server typecheck subsequently passed (`controls-typecheck-long.log`). All final gates still require a new, fully agreed source snapshot.

1. Parent obtains/reviews the contract-compatible V2 amendment; implement that authoritative policy rather than merely adding 2.0.28 to a list.
2. Complete and review the plan's remaining regression matrix: all L/N cells, malformed/pending/expired physical owners, real busy first/breaking activation and independent client race, delayed Location, pending filesystem mutation, crash/multi-process recovery, background deadline/cancellation and polling state coverage.
3. Add packaged-server two-generation behavior/dependency-closure evidence; the native A/B boundary fixture intentionally uses a synthetic canonical result, while current production HTTP/SQLite qualification exercises the real canonical pipeline separately.
4. Audit remaining lifecycle/reference/settlement cases, active/default diagnostics and exceptional manual-source behavior against the latest plan; update the provider report when those contracts are accepted.
   - Broaden interruption/polling coverage beyond the new Effect-interest lifecycle test; add actual RPC cancellation and late-acquisition coverage.
   - Verify active/default diagnostics through real B selection/rollback and expose active-owner identity when safely available.
   - Extend physical-control tests through non-cooperative SDK RPC deadline, native proposal reconciliation and gate-budget exhaustion.
   - Extend strict lease inspection tests through both production cleanup entrypoints and legacy/native crash-recovery cases.
   - Extend failed-start settlement to post-enrollment attach failure and unresolved canonical-resource/receipt cases, preserving quarantine.
   - Qualify the new pre-history foreign-owner guard with independent concurrent app instances; no foreign owner may be detached or mutated to manufacture readiness.
5. Perform final root `bun fmt`, `bun lint`, isolated-cache `bun typecheck`, and isolated-cache `bun run test`, plus matching focused/browser/native suites, against a **new final immutable snapshot/delta**. No full-root test pass or final freeze is claimed here.
6. Parent coordinates independent code/security/requirements reviews. Nested consistency/planner/validation/debugging agents were unavailable at depth 1; no independent source review has accepted this working implementation.

**Code green: No. Implementation/Plan green: No. No commits, pushes or application back to the original checkout.**

## Disjoint regression follow-up while compatibility source is paused

On 14 October, the worktree was reconciled against the immutable incomplete v4 checkpoint before authoring: **296 recorded paths, zero differences**. The checkpoint and delta remain unchanged:

- `thread-tools-stable-bootstrap-working-source-manifest.v4.json`: SHA-256 `cb2e1250a4827453ced5ad91276fef4e510d08521617cb3ed61adbe72caeb37c`.
- `thread-tools-stable-bootstrap-working-source-delta.v4.json`: SHA-256 `9b96441c466eb8a7bdf51378200b7f9eba7e6e3aee4f92887ec0d3754af22745`.

This follow-up changed **only seven test/fixture paths**, plus this ledger. All implementation source, version gates, API/crypto definitions, manifest generators, renderers and readiness semantics still match v4. There were 301 dirty paths after test authoring (296 inherited checkpoint paths plus five new paths). The two changed existing tests reused a new synthetic-authority fixture; no unrelated copied work was edited. All seven authored test/fixture files are below 400 lines (maximum 175).

Added coverage:

- A late interest joins the original job without extending its five-minute creation deadline. Expired jobs reject publication continuations; physical close retains writer ownership/capacity until it actually settles.
- Explicit cancellation removes a previously transferred timeout interest, is idempotent, preserves another interest, and cannot close physical work early. Limits of 32 interests and 32 unsettled jobs reject overflow without evicting quarantined writers.
- The actual pinned SDK and guarded RPC helper run signed renewal against a synthetic non-cooperative fetch. The five-second RPC deadline and fifteen-second join deadline leave its physical promise tracked; both later response and rejection settle it without redispatch.
- Control joins wait for logical record mutation as well as physical operations; cancelling a join cannot free the 32-operation physical capacity.
- Reopening each signed retirement phase preserves archived enrollment evidence. Detach acknowledgement alone, and each of the six individually missing physical/durable proof fields, block settlement. Wrong acknowledgement/replacement identities do not mutate the signed record.
- The emitted N bootstrap rejects genuinely signed L enrollment/renewal replays and malformed or unauthorized L cleanup. L cleanup is idempotent, creates no callback authority, and cannot revoke an N successor even when digest/nonce deliberately collide across domains.

These are **source/owned synthetic regressions**, not real native conformance, full L/N matrix, independent concurrent-app recovery, or packaged-server acceptance. The SDK fixture uses only a synthetic loopback origin/fetch; no native executable, service, configuration, account, paid prompt or real thread was accessed in this follow-up.

Validation logs in the approved temporary directory:

| Check                                                                                                         | Result                                            | Log                                                  |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| `bun fmt` with only the seven explicit owned test/fixture paths                                               | Passed                                            | `stable-bootstrap-v4-disjoint-format.log`            |
| `bun x --no-install oxlint --report-unused-disable-directives` with those same seven paths                    | Passed, zero warnings/errors                      | `stable-bootstrap-v4-disjoint-lint.log`              |
| `bun run --cwd apps/server typecheck`                                                                         | Passed; existing advisory Effect diagnostics only | `stable-bootstrap-v4-disjoint-typecheck-final.log`   |
| `bun run --cwd apps/server vitest run` with the nine explicit job/control/retirement/plugin/legacy test paths | Passed: nine files / 19 tests, no skips           | `stable-bootstrap-v4-disjoint-regressions-final.log` |

Exact path-expanded commands are retained in `stable-bootstrap-v4-disjoint-validation-commands.txt`. Every command set `TURBO_CACHE_DIR` to this isolated root's `.turbo/cache`; these package-local commands do not invoke Turbo. An initial server typecheck failed because the resolve-only shared `deferred` fixture has no `reject` method. The correction was test-only: resolve a `Response | Error`, and have the synthetic fetch throw the error. Formatting/lint/typecheck/tests were rerun successfully; the initial failure is retained in `stable-bootstrap-v4-disjoint-typecheck.log`, not counted as a pass.

`thread-tools-stable-bootstrap-disjoint-regression-evidence.v4a.json` records the seven path hashes, ledger hash, exact commands/log hashes and unchanged-v4 implementation-source verification. It is a supplemental **incomplete regression evidence record**, not a new final source freeze or replacement for v4/v3/v2.

Nested consistency, validation and debugging agents again returned **Subagent depth limit reached (1)**. Local patterns/checks were used without bypassing the limit. No independent review is claimed. Compatibility implementation remains blocked on the parent's reviewed amendment; the original-root job was not polled, inspected, stopped or restarted. Full-root formatting/freeze checks remain deliberately deferred while planner authors are active.

All required follow-up items above remain open except the specifically covered regression slices listed here. In particular, packaged genuine A/B through canonical HTTP/SQLite, L-bootstrap qualification, independent multi-instance/native crash recovery, full polling/RPC cancellation coverage, post-enrollment attach-failure settlement, and the new compatibility policy still require implementation/qualification. **Both completion gates remain No.**
