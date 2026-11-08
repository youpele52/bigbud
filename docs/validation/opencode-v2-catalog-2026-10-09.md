# OpenCode V2 full-catalog picker — 9 October 2026

## Authoritative scope

The user explicitly selected **Full catalog** after requesting V1/Pi-style provider/model discovery and picker parity. Exact CLI/client **2.0.26**, disabled attachments, private V2 profiles, no fallback, native deletion safety and unapproved shared remote TS/Rust work remain unchanged. This is catalog usability evidence, not full-release readiness or resolution of historical unrelated workspace flakes.

Branch `dev`, baseline `258d99eb4ee822744f6e14d822a306e8532f36f5`. Pre-existing dirty work is preserved. No dependency pin, V1 executable, durable user profile, credentials or ambient authentication was modified by this catalog slice. Native probes use newly created disposable profiles and do not send any model prompt.

## Source evidence

Official [providers guide](https://opencode.ai/v2/docs/providers), [models guide](https://opencode.ai/v2/docs/models), API guide and Context7 `/websites/opencode_ai_v2` agree that selection lists available models, with current-project availability distinct from the catalog. The installed Promise client has no full/include-disabled parameter.

Immutable official tag `v2.0.26`, commit `9b4ec5714d481559990db0a816d5dec19541a814`:

- [`packages/server/src/handlers/model.ts`](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/server/src/handlers/model.ts): `model.list` returns `models.available()`.
- [`packages/server/src/handlers/provider.ts`](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/server/src/handlers/provider.ts): `provider.list` returns `providers.available()`; no full inventory endpoint is exposed here.
- [`packages/core/src/models-dev.ts`](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/core/src/models-dev.ts): native public source is `https://models.opencode.ai/api.json`; it keeps a bundled boot-time snapshot, builds exact model/mode IDs, and computes native variants.
- [`packages/core/src/plugin/models-dev.ts`](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/core/src/plugin/models-dev.ts): excludes retired Azure/Vertex aliases and non-text/deprecated models.
- [`packages/cli/src/server-process.ts`](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/cli/src/server-process.ts): `OPENCODE_DISABLE_MODELS_FETCH` sets `fetch: false`, not `snapshot: false`. Removing this flag would not turn the available-only API into a full-catalog API. Local/SSH launcher flags are unchanged.

Public metadata is schema-decoded and projected to IDs/names only. No package, endpoint, body, header, credential variable, or source-provided executable is trusted or exposed. Native provider metadata is projected to ID/name, never logged whole.

Observed public feed SHA-256: `7f362fea07f00c3273d4fe945122eefe5f48b6c2a9d18d80f485b1feae6572de`. Complete **223-subprovider normalized counts** are reproducible by applying `normalizeV2PublicCatalog` and counting `subProviderID`; the preserved public-only diagnostic JSON is `catalog-all-subprovider-counts.json` in the approved OpenCode temporary directory. The source URL, normalization implementation, aggregate and representative counts below are durable evidence; that temporary diagnostic is not the sole specification.

## Actual no-account native observation

`Catalog.native.test.ts` used the separately installed official native **2.0.26** executable (`~/.bigbud/tools/opencode-v2/2.0.26/opencode`, SHA-256 `1b6418a3bd4211344d8a2b75d7d4367b24283ae548bd6b896cf717f6f8858f26`) but **not** the durable V2 profile. It exercised production `makeV2DevelopmentProvider` through the real owned authenticated native process and actual public network source.

| Observation                                                                   | Actual result                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Immediate native `model.list` before async settlement                         | 0                                                            |
| Native `model.list` after settlement, no connected account                    | 11 OpenCode/free entries                                     |
| Official public feed raw                                                      | 225 providers / 8,466 model records / 5,374,726 bytes        |
| Public text-capable/nondeprecated normalization, including published mode IDs | 223 subproviders / 7,950 entries                             |
| Native + full public merged production snapshot                               | 223 subproviders / 7,951 entries                             |
| Serialized model snapshot size                                                | 1,411,118 bytes                                              |
| Snapshot account status                                                       | `unknown`, not authenticated                                 |
| OpenAI public-only preflight                                                  | Rejected with dedicated-profile guidance, no prompt/fallback |
| Model prompts or real billing                                                 | 0                                                            |

The native snapshot adds one pinned native ID absent from the current public feed and overrides matching live variants. Native availability/free access is not account authentication. Counts are an observed 9 October feed snapshot, not hardcoded product constants. Public/native initialization and subsequent public changes can change counts.

| Subprovider                 | Public normalized entries | Merged entries |
| --------------------------- | ------------------------- | -------------- |
| OpenAI (`openai`)           | 79                        | 79             |
| Anthropic (`anthropic`)     | 20                        | 20             |
| Google (`google`)           | 30                        | 30             |
| OpenCode Zen (`opencode`)   | 84                        | 85             |
| OpenCode Go (`opencode-go`) | 31                        | 31             |
| Azure (`azure`)             | 85                        | 85             |

## Implementation and limits

- `Catalog.public.ts`: exact real public IDs/names, text/deprecation/retired-alias filtering, native-style explicit mode IDs, explicit-entry collision deduplication; unknown capabilities for public-only models. Scoped single-flight cache, one-hour TTL, 30-second failed refresh retry, last-good cache, 5-second fetch deadline, 8 MiB byte ceiling, 1,000 providers and 10,000 model entries. No credentials or redirects. No V1 cache/profile reuse.
- `Catalog.ts` / `Development.provider.ts`: real native provider display names via the existing shared helper; native custom/canonical IDs/names/variants win. Public models missing from the native inventory remain setup-only, including paid models of an available free provider. Missing native inventory never silently becomes availability proof. Account status remains unknown. Readiness and refresh failures retain previous catalog data and safe diagnostics.
- `Catalog.native.ts` / `Runtime.model.availability.ts` / `Runtime.admission.ts`: up to five read-only native reads with 250 ms spacing under the existing 10-second request deadline; exact native Location/model/variant preflight occurs before a new journal intent/prompt. Existing accepted-request replay bypasses new readiness checks and preserves its historical result. This does not change authorization, saved approvals, uncertainty fences or native model readback.
- Shared web/mobile option mapping carries setup-only metadata. The existing incremental grouped/searchable/recent picker renders setup labels and a compact warning with full detail in its tooltip. No bespoke V2 picker and no dropped recent selections. Exact subprovider IDs survive duplicate slugs. Initial probe loading is truthful; other providers' readiness behavior is unchanged.
- Existing native fetch-disable flags and event/response/transport limits are unchanged. No global larger response allowance, media support or stress attachment was introduced.

## Validation and review

Final source validation completed; all tests below passed without skips. No task-owned background validation remains. These are scoped checks, not a new full-workspace release run.

| Exact command / group                                                              | Completed result                                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun fmt`                                                                          | Passed; 8,299 files scanned.                                                                                                                                                           |
| `bun lint`                                                                         | Passed; 25 warnings, zero errors; no file-length policy violations.                                                                                                                    |
| `bun typecheck`                                                                    | Passed; 9/9 uncached workspace tasks; non-failing Effect advisories remain.                                                                                                            |
| Server command below                                                               | 16 files / 56 tests passed; catalog parsing/bounds/cache, setup snapshots, model availability, replay, authorization, instruction, learning/restart and synthetic remote preservation. |
| Native command below                                                               | 4 files / 5 tests passed; official exact 2.0.26 with disposable profiles and loopback synthetic models, plus explicitly authorized public catalog network read. No real vendor prompt. |
| Web command below                                                                  | 5 files / 33 tests passed.                                                                                                                                                             |
| Chromium command below                                                             | 2 files / 5 tests passed; same-slug subproviders, grouping, search, setup labels, exact recent selection, settings and native model changes.                                           |
| Mobile command below                                                               | 2 files / 6 tests passed.                                                                                                                                                              |
| `bun run --cwd packages/contracts vitest run src/core/settings.opencodeV2.test.ts` | 1 file / 3 tests passed.                                                                                                                                                               |
| `git diff --check`; authored-code scan                                             | Passed; 103 changed source/test/code-config files across the entire inherited worktree, maximum 386 lines, none over 400; no staged files.                                             |

```sh
bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/Catalog.test.ts src/provider/Layers/OpencodeV2/Catalog.public.test.ts src/provider/Layers/OpencodeV2/Development.catalog.test.ts src/provider/Layers/OpencodeV2/Runtime.model.availability.test.ts src/provider/Layers/OpencodeV2/Runtime.model.test.ts src/provider/Layers/OpencodeV2/Runtime.model.fences.test.ts src/provider/Layers/OpencodeV2/Runtime.test.ts src/provider/Layers/OpencodeV2/Runtime.learning.binding.test.ts src/provider/Layers/OpencodeV2/Runtime.finalization.test.ts src/provider/Layers/OpencodeV2/Runtime.transportLoss.test.ts src/provider/Layers/OpencodeV2/Runtime.policy.admission.test.ts src/provider/Layers/OpencodeV2/Runtime.shutdownLoss.test.ts src/provider/Layers/OpencodeV2/Runtime.instructions.test.ts src/provider/Layers/OpencodeV2/Runtime.learning.races.test.ts src/provider/Layers/OpencodeV2/Remote.integration.test.ts src/orchestration/Layers/LearningReactor.process.restart.test.ts

BIGBUD_OPENCODE_V2_TEST_BINARY="$HOME/.bigbud/tools/opencode-v2/2.0.26/opencode" BIGBUD_OPENCODE_V2_PUBLIC_CATALOG_SMOKE=1 bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/Catalog.native.test.ts src/provider/Layers/OpencodeV2/Development.integration.native.test.ts src/provider/Layers/OpencodeV2/Runtime.model.native.test.ts src/provider/Layers/OpencodeV2/Runtime.permissions.native.test.ts

bun run --cwd apps/web vitest run src/components/chat/provider/ProviderModelPicker.availability.test.ts src/models/provider/opencodeV2.models.test.ts src/models/provider/selection.models.test.ts src/models/provider/provider.models.test.ts src/models/recentlyUsedModels.test.ts
bun run --cwd apps/web test:browser src/components/chat/provider/ProviderModelPicker.opencodeV2.browser.tsx src/components/settings/ProviderCard.opencodeV2.browser.tsx
bun run --cwd apps/mobile-web vitest run src/logic/mobileModelSelection.opencodeV2.test.ts src/screens/MobileThread.commands.test.ts
```

Two intermediate failures are not hidden: an aggregate typecheck tool deadline initially killed the still-running server typecheck (rerun passed all nine tasks); the first exact-native model preflight read preceded asynchronous plugin settlement (bounded shared retry fixed it, and native model-switch/replay passed). Synthetic model tests initially counted new GET `/model` reads as switches; assertions now correctly count only POST mutations, preserving their no-extra-switch contract. No timeout/request/event bound was relaxed. No unrelated failure was edited. Global formatting/Turbo can rewrite the managed `AGENTS.md` trailing blank line; its original content is restored at handoff, not included as a catalog change.

**Scoped Code green: Yes. Implementation/Plan green: No — independent parent review remains unavailable at nested depth 1.** Direct checklist review found every catalog-slice item implemented and supported by the commands above; no unresolved in-scope implementation issue was found. This is not independent reviewer clearance or broader release conformance.

Nested `code-consistency`, `format-lint-test-fixer` and final `review` delegation were rejected by the configured **depth limit 1**. Direct source/checklist review is not independent parent-review clearance. Parent should review `Catalog.public/native.ts`, `Catalog.ts`, `Development.provider.ts`, `Runtime.model.availability.ts` / `Runtime.admission.ts`, the optional contract availability field, web/mobile option mapping and shared model list/browser regressions. Check full-catalog merge, setup-only semantics, authorization/preflight ordering, cache bounds and exact recent/duplicate identity. No background validation remains at handoff; no commit or push was made.

The user's remaining model-specific action is to run `/connect` or configure credentials **in the dedicated V2 profile**, then refresh bigbud. Browsing and choosing models requires no account. The separately prepared `~/.bigbud/tools/opencode-v2/connect` helper targets that profile; it was not run interactively by this catalog slice. Never use the ambient V1 profile as fallback.

## Parent ordering finding and correction — latest revision

Parent review found an ordering gap in the preceding revision: the availability check inside prompt admission ran **after** `switchV2TurnModel`, and fresh startup created native history without an availability preflight. An unavailable public-only selection could therefore dispatch a rejected switch and quarantine the owned namespace before returning actionable setup guidance. This supersedes the preceding direct-review claim that no in-scope issue remained; the parent did not clear implementation review.

**Reproduction before production edits:** `Runtime.model.setup.test.ts` failed both boundary regressions. Fresh unavailable startup resolved after creating history. The idle-switch test observed one native `switchModel`, a generic unconfirmed-admission error, `V2 native mutation is unconfirmed; process namespace quarantined`, and rejection of a subsequent original-model turn. Evidence: approved-temp `catalog-ordering-reproduction.log`. This is production runtime/client/SQLite wiring with a synthetic unavailable-switch transport rejection, not a claim of real-vendor rejection semantics.

**Minimal correction:** `Runtime.model.ts` performs exact native availability preflight inside the existing namespace/owner guard **before** its final idle read and `switchModel`. Its existing post-read and synchronous dispatch authorization remain intact. `Runtime.sessions.ts` preflights **only the fresh-create branch**, then rechecks executable/settings authorization, cancellation, namespace safety and process liveness before creation. Existing history/resume skips availability, retaining native model readback. `Catalog.native.ts` and `Runtime.model.availability.ts` now propagate startup cancellation through the bounded native read. The pre-prompt availability check remains for every newly admitted turn; immutable accepted replay continues to bypass it.

The synthetic HTTP fixture now has an independent configured inventory instead of manufacturing model availability from saved session selections. New tests prove zero create/switch/instruction/prompt/journal mutation for known-unavailable selections, no mutation quarantine, original owner usability, settings/cancel/process changes while startup waits on catalog data, switch settings changes while waiting, and terminal-history rebind/replay with no availability reads. Existing fence assertions now count POST mutations rather than miscounting GET `/model` catalog reads.

Final source checks for this correction:

| Check                                                     | Completed result                                                                                                                             |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun fmt`; `bun lint`; `bun typecheck`                    | Passed in order; lint 24 warnings / zero errors; typecheck 9/9 uncached tasks.                                                               |
| Expanded synthetic server command below                   | 42 files / 166 tests passed; no skips. Excludes native and historical media tests.                                                           |
| Exact-native command in the preceding section             | Repeated: 4 files / 5 tests passed; no skips, only disposable profiles / synthetic loopback models and explicit public catalog network read. |
| Web / Chromium / mobile commands in the preceding section | Repeated: 33 / 5 / 6 tests passed respectively.                                                                                              |
| Ordering-only command below                               | 4 files / 20 tests passed, including seven setup/rebind/race regressions; repeated after the final zero-journal assertion.                   |

```sh
bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/Runtime src/provider/Layers/OpencodeV2/Catalog.test.ts src/provider/Layers/OpencodeV2/Catalog.public.test.ts src/provider/Layers/OpencodeV2/Development.catalog.test.ts src/provider/Layers/OpencodeV2/Remote.integration.test.ts src/orchestration/Layers/ProviderCommandReactorSessionOps.opencodeV2.model.test.ts src/orchestration/Layers/ProviderCommandReactorSessionOps.opencodeV2.references.test.ts src/orchestration/Layers/SchedulerReactor.opencodeV2.integration.test.ts src/orchestration/Layers/LearningReactor.process.restart.test.ts --exclude '**/*.native.test.ts' --exclude '**/Runtime.media.*'

bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/Runtime.model.setup.test.ts src/provider/Layers/OpencodeV2/Runtime.model.test.ts src/provider/Layers/OpencodeV2/Runtime.model.availability.test.ts src/provider/Layers/OpencodeV2/Runtime.model.fences.test.ts
```

Production native observation is unchanged: **7,951 browseable entries / 223 subproviders**, native immediate **0** → settled **11** OpenCode/free entries, auth **unknown**, catalog smoke **zero prompts**. No credentials, durable profile, media behavior, native request/event bounds or exact 2.0.26 pin were changed. All jobs complete at handoff. **Scoped Code green: Yes; Implementation/Plan green: No, pending parent's review of this correction.** Inspect preflight-before-switch/create ordering, cancellation propagation, final guards and replay exemption; original broader release gates remain unchanged.

## Parent scoped confirmation

Parent source review checked public catalog bounds/cache and native-precedence merge, provider grouping, shared incremental picker/setup labels, exact subprovider identity, preflight-before-switch/fresh-create ordering and existing-history/replay exemption. The ordering finding above is corrected. Fresh parent checks passed **6 server files / 27 tests** (`Catalog`, `Catalog.public`, `Development.catalog`, `Runtime.model.setup`, `Runtime.model.fences`, `Runtime.model.availability`) and **3 web files / 25 tests** (picker availability, V2 model mapping, recently used models). `git diff --check` passed. No production code was changed during this confirmation.

The requested full-catalog/grouped-picker slice is implemented and scoped-reviewed. This is not clearance for real vendor generation, native deletion, shared remote protocol changes or broader original release conformance. Restart/reload the development app and refresh provider discovery to use the new catalog; model-specific sign-in is still required where marked. No commit, push or task-owned background validation remains.
