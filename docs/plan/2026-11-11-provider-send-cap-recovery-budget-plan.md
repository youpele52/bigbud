# Remove the provider send-text cap and separate recovery-context budgets

## 1. Metadata

- **Status:** Ready for implementation.
- **Created:** 2026-11-11T13:41:00+01:00.
- **Last modified:** 2026-11-11T13:44:00+01:00.
- **Project root:** `/Users/youpele/DevWorld/bigbud`.
- **Inspected branch:** `dev`.
- **Inspected commit:** `f73faab0d38de32c6f3839bae1deb5d9763e6f92`.
- **Related issues, notes, and cards:** None supplied or identified for this request; no identifiers invented.
- **Authorization:** Saved implementation plan only. No implementation, worktrees, commits, pushes, or broad validation authorized.
- **Path convention:** File paths below are relative to the absolute project root above unless explicitly absolute.
- **Instructions:** Supplied global instructions, root `AGENTS.md` and its `CLAUDE.md` symlink inspected. No nested `AGENTS.md` or `CLAUDE.md` found in the affected TypeScript/documentation areas. The existing plan-authoring guide was also inspected.
- **Existing artifacts:** Searched both `docs/plan/` and `docs/plans/` for this work. No matching cancelled-planner artifact found. Inspected the unrelated shell-profile plan in `docs/plan/`; leave it untouched. Older recovery/OpenCode plans are not this task.
- **Initial worktree:** Substantial unrelated modified and untracked server, web, contracts, and terminal work, including an existing untracked `docs/plan/` directory. None of the mandatory production targets below appeared as modified in the initial status. The SHA-256 of `git status --porcelain=v1 -uall` before and after read-only research was `a913e0abd0dd1eef3b094bfc85a8f57418fce508049d7e048d0b688340a43ac9`.

## 2. Goal and definition of done

Remove the application-wide 120,000-character provider send-text limit without replacing it with a universal token threshold or another final-send cap. Preserve the actual current user request while bounding replayed history and existing compact-reference expansion independently.

### Acceptance criteria

1. Valid text of 120,001 characters and substantially longer text passes the shared send and steer schemas and reaches a fake adapter unchanged, subject to existing whitespace normalization. Optional send text and required steer text retain their existing semantics.
2. Recovery never slices the current provider request to fit history. This includes a current message larger than the entire replay budget and messages with compact references, reply metadata, or file-context wrappers.
3. Replayed history has its own finite character budget, independent of current-request length and context added later. No total-output-length constraint is imposed.
4. Compact-reference expansion retains the entire original message and bounds only the generated reference section; existing per-reference and reference-count bounds remain.
5. A fresh/rebuilt send containing bounded history plus capability/thread context, memory, referenced threads, and desktop-resource context can exceed 120,000 characters without the removed validation failure. Context ordering and delivery bookkeeping remain unchanged.
6. Existing no-duplicate rules remain: active/native-resumed sessions do not receive transcript replay; revive does not replay; an already-persisted current request is not also replayed as history; uncertain trailing turns remain excluded. New branch/fork bootstrap behavior remains supported.
7. All four inspected OpenCode V2 duplicate send-text checks are removed, but its attachment counts, media/storage byte limits, ownership fences, immutable preparation, fingerprints, and no-resend rules remain effective.
8. Focused tests, explicit-path formatting/lint, affected-package configured typechecks, and direct checks that every added/materially edited source/test file is at most 400 lines pass, or unrelated baseline failures are explicitly reported without being called passed.

## 3. Background and evidence

### Confirmed call path

- `packages/contracts/src/orchestration/orchestration.provider.ts:183` exports `PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000`.
- `packages/contracts/src/orchestration/provider.ts:71-108` applies it to optional `ProviderSendTurnInput.input` and required `ProviderSteerTurnInput.input`. The second occurrence is steering, not another attachment or transport limit.
- `apps/server/src/provider/Layers/ProviderService.sendTurn.ts:58-70` decodes the fully composed payload before adapter routing. Keep this validation layer; remove only the schema's text maximum.
- `apps/server/src/orchestration/Layers/ProviderCommandReactorHandlers.ts:189-212` expands mentions, adds reply context, then adds file-attachment context. Thus the latest provider text is not necessarily identical to persisted user text.
- `apps/server/src/orchestration/Layers/ProviderCommandReactorInputExpansion.ts:326-335` truncates the original message and resolved references together to the shared maximum. A large message with a recognized reference can lose its tail before send.
- `apps/server/src/orchestration/Layers/ProviderCommandReactorHelpers.ts:201-235` excludes uncertain/current history and calls `buildBootstrapInput` with the same 120,000 value.
- `packages/shared/src/history.ts:101-199` currently treats its third argument as the complete output budget. It slices an oversized latest prompt even when there is no history, and charges the latest prompt against replay capacity.
- `apps/server/src/orchestration/Layers/ProviderCommandReactorSessionOps.send.ts:140-204` adds capability/thread context, persistent memory, attached-thread text, and resource context after bootstrap construction. The final text can therefore exceed the shared validator's maximum despite bootstrap satisfying it.
- `apps/server/src/orchestration/Layers/ProviderCommandReactorSessionOps.resourceContext.ts:142-158` already bounds its resource JSON separately. Its position at the beginning of a validation error's text does not prove that it caused the overrun.

### Narrow OpenCode V2 classification

| File                                                                        | Confirmed meaning                                                                                            | Required treatment                                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `apps/server/src/provider/Layers/OpencodeV2/Adapter.admission.ts:12`        | Development no-execution transport checks text against shared maximum                                        | Remove maximum only; retain nonblank and correlation checks                                     |
| `apps/server/src/provider/Layers/OpencodeV2/Runtime.input.ts:15-19`         | Runtime checks raw send text against shared maximum                                                          | Remove text maximum only; retain empty-content/attachment-count, interaction-mode, epoch checks |
| `apps/server/src/provider/Layers/OpencodeV2/Runtime.admission.ts:190-193`   | Rejects final prompt plus attachment references above 120000 characters                                      | Remove this combined send-text rejection                                                        |
| `apps/server/src/provider/Layers/OpencodeV2/Runtime.attachments.ts:133-145` | Rejects prepared prompt plus references above 120000 characters, separately from serialized-media byte bound | Remove character rejection only; preserve `V2_MEDIA_RESPONSE_BYTES` checks on read and write    |
| `apps/server/src/provider/Layers/OpencodeV2/Runtime.session.decode.ts`      | Native session title bound                                                                                   | Unchanged                                                                                       |
| `apps/server/src/provider/Layers/OpencodeV2/Orchestration.receipts.ts`      | Receipt content byte bounds                                                                                  | Unchanged                                                                                       |

Search also found unrelated 120,000-millisecond timeouts, attachment-size fixtures, and recovery timing constants. They are not send-text checks and must not be changed.

### Diagnosis and evidence limits

High confidence in the structural budgeting/validation mismatch and current-message truncation, established by source inspection. No failed-turn full payload or exact original error report was available; do not attribute the incident to a specific resource block, provider, or token count. No reproduction test or implementation test was run during planning. The regression fixtures below provide deterministic reproduction without a live model.

## 4. Plan assumptions

- **Preservation means no new truncation or rewriting of current content.** Existing `TrimmedNonEmptyString` and `toNonEmptyProviderInput` whitespace behavior stays. Verify exact preservation with sentinel-bearing non-whitespace text, and separately retain existing whitespace tests.
- **Keep the existing 120,000 magnitude for the two existing budgeting responsibilities, not for sending.** Name and scope them explicitly as replay-history and compact-reference-context budgets. This minimizes policy changes while severing their accidental coupling to current-message length. Tests must demonstrate that the final output can exceed both budgets.
- **The bootstrap helper is internal to this monorepo.** Search found production use through `buildResumedTurnInput`, a web compatibility re-export, and shared/server tests. Verify those references again before changing semantics; no external SDK/API compatibility guarantee was identified.
- **Provider/native limits remain possible.** Passing application validation does not promise any provider accepts unlimited text. Existing provider errors and recovery behavior remain; no model discovery or token estimation is necessary.

These are bounded implementation interpretations of the agreed scope, not unresolved product decisions.

## 5. Scope

### Mandatory

- Shared send/steer schema cap removal and removal of the obsolete shared send-cap constant.
- Shared bootstrap budgeting semantics and current-request preservation.
- Compact-reference expansion budgeting without current-message truncation.
- The four identified OpenCode V2 duplicate text checks.
- Focused regression tests and affected-package validation.

### Explicitly out of scope

- Context-window UI, warnings, settings, model-limit discovery, token estimation, or replacement universal thresholds.
- New aggregate budgets for capability context, memory, attached threads, or final payloads.
- Provider redesign, new payload protections, broader hardening, transport changes, dependency changes, migrations, telemetry projects, or unrelated numeric-bound cleanup.
- Changes to existing attachment, receipt, title, storage, or transport limits.

### Preserve unchanged

Context ordering; capability-context state and deduplication; resource state commitment after successful send; attachment routing; existing schema validation besides text maxima; recovery eligibility and dispatch safety; provider error classification; durable IDs and admission fingerprints for unchanged inputs.

Deferred ideas: model-aware budgeting or new context controls would require a separate request. They are not prerequisites or optional implementation steps here.

## 6. Repository findings and reuse targets

- Keep `buildBootstrapInput` in `packages/shared/src/history.ts`; reuse its formatting, chronology, image summaries, reply context, and result metadata. No generic budgeting framework or new package is needed.
- Keep filtering in `ProviderCommandReactorHelpers.ts`; distinguish raw persisted message text from expanded current provider text.
- Keep `ProviderCommandReactorSessionOps.send.ts` and `.context.ts` behavior as-is unless a test exposes a direct integration defect. The fix does not require rearranging context composition.
- `apps/web/src/utils/history/bootstrap.utils.ts` re-exports the helper; `apps/web/src/utils/history/index.ts` re-exports that module. Search found no additional invocation. No UI edits planned.
- `ProviderService.routing.cursor.test.ts` is the other cap-constant consumer; migrate its bootstrap chronology test to the history-specific constant.
- Reuse `ProviderService.test.helpers.ts` (`makeProviderServiceLayer`, fake adapter mocks) for real service-boundary validation, not only schema assertions.
- Reuse `ProviderCommandReactor.test.helpers.ts`, `.test.settleTurn.ts`, and `.sessionRecovery.test.helpers.ts` for orchestration integration. Its `sendTurn` is mocked: additionally decode captured payloads with the real `ProviderSendTurnInput` schema and test the actual service separately.
- Reuse OpenCode V2 `Runtime.fixture.ts`/`withV2RuntimeFixture` and existing attachment-preparation/replay test patterns. Use fake clients, not live provider credentials or native installations.
- Current sizes leave room in production targets: shared history 201 lines, expansion 337, helpers 237, send 294, V2 admission 351. `ProviderCommandReactor.turnStart.test.ts` is already 379 lines, so add a focused sibling rather than growing it past 400. `ProviderService.test.helpers.ts` is 380 lines: reuse without expanding it unnecessarily.
- Package scripts for contracts, shared, and server all define `typecheck: tsc --noEmit` and `test: vitest run`. Root scripts use Turbo/broad scans and are not appropriate here.
- Actual server Vitest configuration has parallel audited unit tests and serial integration tests; new tests default to integration. Preserve its grouping and 60-second timeout; do not regenerate manifests.

## 7. Implementation steps

### Step 1 — Separate replay budget from current request

Modify `packages/shared/src/history.ts` and `packages/shared/src/history.test.ts`.

1. Export a history-specific constant, `DEFAULT_BOOTSTRAP_HISTORY_MAX_CHARS = 120_000`, from the existing `@bigbud/shared/history` subpath. This is a replay allowance, never a send limit.
2. Keep the helper's three-argument shape but rename/document the third argument as `maxHistoryChars`. It counts all generated replay framing: preamble, transcript header, role labels, message text/attachment/reply summaries, separators, omission summary, and latest-request header/separator. It does not count any character of `latestPrompt`.
3. Normalize finite budgets to a nonnegative floored integer; invalid/non-finite/negative budgets mean zero replay allowance. A zero/tiny allowance must still return the complete current request.
4. With no previous messages, return `latestPrompt` unchanged, `includedCount = 0`, `omittedCount = 0`, `truncated = false` regardless of prompt length.
5. Select the newest contiguous suffix of whole history blocks, rendered chronologically. Preserve the existing stop-at-first-nonfitting-block policy rather than selectively skipping a large recent block to include older ones. Account for omission-summary length while fitting.
6. If only an omission-summary prefix fits, retain that behavior. If framing cannot fit, return the full prompt alone. Never slice the latest prompt or a history message merely to fill the allowance.
7. `includedCount`/`omittedCount` describe history; `truncated` means history was omitted, not that the current request was modified. For a nonempty history, the generated prefix length must be at most `maxHistoryChars`; total text may be longer by the full latest request length.
8. Keep result fields and all other history exports unchanged. Avoid constructing repeated copies of a large current request during fit checks: measure the history prefix, then concatenate the request once.

Update `apps/server/src/orchestration/Layers/ProviderCommandReactorHelpers.ts` to use the history-specific constant. Leave its current-message/uncertain-turn filtering intact. Update `apps/server/src/provider/Layers/ProviderService.routing.cursor.test.ts` to import the same constant through the shared subpath rather than the old contracts cap.

### Step 2 — Preserve current text during compact-reference expansion

Modify `apps/server/src/orchestration/Layers/ProviderCommandReactorInputExpansion.ts` and its existing `.test.ts`.

1. Remove the send-cap import. Introduce local `MAX_REFERENCE_CONTEXT_CHARS = 120_000` for the existing generated reference-section allowance.
2. Build and bound the generated resolved-reference heading and blocks separately, then compose them with `Original user message:` and the complete original text. Count any reference truncation marker within the reference-section allowance.
3. Keep no-mention input as an exact passthrough; keep discovery selection, ordering, deduplication, missing/ambiguous messages, and slash-skill behavior.
4. Preserve `MAX_REFERENCE_BLOCKS = 12`, `MAX_DIRECTORY_ENTRIES = 80`, and `MAX_TEXT_BLOCK_CHARS = 16_000`. Retain per-source truncation. Change truncation wording that incorrectly claims a provider input limit to describe reference-context limits.
5. Do not wrap the final combined output in another truncation function or subtract current-message length from the reference allowance.

### Step 3 — Remove the shared send/steer cap, not validation

Modify:

- `packages/contracts/src/orchestration/orchestration.provider.ts`: remove `PROVIDER_SEND_TURN_MAX_INPUT_CHARS`; retain the attachment constant and unrelated definitions.
- `packages/contracts/src/orchestration/provider.ts`: remove only the max-length checks/import for send and steer text. Preserve optional versus required `TrimmedNonEmptyString` and all other fields/constraints.
- `packages/contracts/src/orchestration/provider.test.ts`: add schema regressions.

Do not bypass `ProviderService.sendTurn` decoding or alter its empty-input/attachment check, durable dispatch tracking, or error handling. No production edit to that service should be necessary.

### Step 4 — Remove only matching OpenCode V2 checks

Apply the required treatment from the classification table to exactly these production files:

- `apps/server/src/provider/Layers/OpencodeV2/Adapter.admission.ts`.
- `apps/server/src/provider/Layers/OpencodeV2/Runtime.input.ts`.
- `apps/server/src/provider/Layers/OpencodeV2/Runtime.admission.ts`.
- `apps/server/src/provider/Layers/OpencodeV2/Runtime.attachments.ts`.

Remove obsolete imports and update comments only where they now misdescribe text bounds. Do not alter preparation serialization, native prompt text, fingerprint construction, request/binding identities, journal behavior, fences, or `resume`/delivery flags. Removing the maximum is not permission to remove the independent prepared-media byte limit.

Repeat the targeted cap-symbol/literal search to ensure no identical app-imposed send-text enforcement remains. Classify matches rather than globally deleting `120000`/`120_000`.

### Step 5 — Add focused regressions at each affected boundary

Use the files and cases in the validation matrix below. Add these focused siblings to avoid oversized existing files:

- `apps/server/src/provider/Layers/ProviderService.sendTurn.largeInput.test.ts`.
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.largeInput.test.ts`.
- `apps/server/src/provider/Layers/OpencodeV2/Runtime.input.largeInput.test.ts`.
- `apps/server/src/provider/Layers/OpencodeV2/Adapter.admission.largeInput.test.ts`.

Extend existing `ProviderCommandReactorSessionOps.context.test.ts` and `OpencodeV2/Runtime.attachments.test.ts` where their fixtures already cover the required boundaries. Keep each authored source/test at most 400 lines; split a test by concern if needed, without a broad cleanup.

No migration or configuration change is required. Use direct contract subpaths for new imports and existing Effect/test patterns.

## 8. Validation plan

### Regression matrix

| Boundary                          | Required evidence                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts `provider.test.ts`      | Send and steer accept text at 120000, 120001, and 240000 characters; preserve complete sentinel-bearing text; send remains optional, steer remains required; blank text and invalid attachment counts retain existing rejection behavior                                                                                                                                |
| Shared `history.test.ts`          | Full newest-first selection rendered chronologically; omitted old history; no history with oversized current request; history plus current request larger than budget; identical history selection for short versus huge current request; zero/tiny/invalid budgets; exact prompt tail retained; counts accurate; prefix within budget; image/reply summaries preserved |
| Expansion `.test.ts`              | Large no-mention passthrough; large message with agent/skill/path reference retains beginning and end; generated reference section bounded independently even with 12 large sources; current message occurs once in original-message section; existing missing/ambiguous/retired-token behavior unchanged                                                               |
| Context `.context.test.ts`        | Expanded current request differs from persisted raw text but remains complete and is not replayed twice; completed history remains bounded; streaming/failed/trailing uncertain content excluded; retained V2 native history excluded; branch/fork bootstrap unchanged                                                                                                  |
| New service large-input test      | Start fake session through real service layer, send long text, assert exact adapter argument and one call; attachment-only remains supported; empty-without-attachment remains rejected; ordinary adapter failure still propagates                                                                                                                                      |
| New reactor large-input test      | Fresh send and lost-session/rebuilt send with >120k current text; history near its replay allowance followed by memory/capability or fallback-thread context, attached-thread context, and deterministic resource context; capture final payload, assert full current request/tail, real schema acceptance, context presence, and one intended dispatch per request     |
| Reactor replay safety             | Preserve live-session and revive no-replay behavior and existing context-limit retry tests; assert markers from replayable history occur only in intended rebuilt sends, not native-resumed sends. Do not assert the same quoted text can never appear in an intentionally attached thread                                                                              |
| New V2 runtime large-input test   | With `withV2RuntimeFixture`, send >120k text through raw validation and final admission to fake native prompt; assert exact text, acknowledgement, and no second prompt on same-request replay; direct validator checks retain empty/attachment-count/epoch/interaction fences                                                                                          |
| Existing V2 attachments test      | Current text below 120k plus valid bounded attachment context crosses 120k; preparation and dispatch succeed, text tail retained, existing immutable replay does not reread/resend; fixtures stay well below unchanged media byte limit                                                                                                                                 |
| New V2 development transport test | Fake correlated native acknowledgement accepts >120k text; blank text, mismatched correlation, and unconfirmed admission retain current behavior; no live child process needed                                                                                                                                                                                          |

For orchestration composition, use deterministic resource/memory fixtures and real composition functions, not a hand-built approximation of their concatenation. The reactor harness mocks the service, so explicitly decode its captured final input and retain the separate real-service test. Cover capability-enabled and disabled fallback composition without changing production feature flags or settings.

### Commands for the implementing agent

Run from `/Users/youpele/DevWorld/bigbud`. These commands are scoped; do not run them during planning.

```sh
bun run --cwd packages/contracts vitest run src/orchestration/provider.test.ts
bun run --cwd packages/shared vitest run src/history.test.ts
bun run --cwd apps/server vitest run src/provider/Layers/ProviderService.sendTurn.largeInput.test.ts src/provider/Layers/ProviderService.routing.cursor.test.ts
bun run --cwd apps/server vitest run src/orchestration/Layers/ProviderCommandReactorInputExpansion.test.ts src/orchestration/Layers/ProviderCommandReactorSessionOps.context.test.ts src/orchestration/Layers/ProviderCommandReactor.largeInput.test.ts src/orchestration/Layers/ProviderCommandReactor.sessionRecovery.contextLimit.test.ts
bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/Runtime.input.largeInput.test.ts src/provider/Layers/OpencodeV2/Adapter.admission.largeInput.test.ts src/provider/Layers/OpencodeV2/Runtime.attachments.test.ts src/provider/Layers/OpencodeV2/Runtime.admission.preparation.test.ts
bun run --cwd packages/contracts typecheck
bun run --cwd packages/shared typecheck
bun run --cwd apps/server typecheck
```

Run explicit-path formatting and lint, without root lint or Turbo:

```sh
bun run oxfmt --check packages/contracts/src/orchestration/orchestration.provider.ts packages/contracts/src/orchestration/provider.ts packages/contracts/src/orchestration/provider.test.ts packages/shared/src/history.ts packages/shared/src/history.test.ts
bun run oxlint --report-unused-disable-directives packages/contracts/src/orchestration/orchestration.provider.ts packages/contracts/src/orchestration/provider.ts packages/contracts/src/orchestration/provider.test.ts packages/shared/src/history.ts packages/shared/src/history.test.ts
bun run oxfmt --check apps/server/src/orchestration/Layers/ProviderCommandReactorHelpers.ts apps/server/src/orchestration/Layers/ProviderCommandReactorInputExpansion.ts apps/server/src/orchestration/Layers/ProviderCommandReactorInputExpansion.test.ts apps/server/src/orchestration/Layers/ProviderCommandReactorSessionOps.context.test.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.largeInput.test.ts apps/server/src/provider/Layers/ProviderService.routing.cursor.test.ts apps/server/src/provider/Layers/ProviderService.sendTurn.largeInput.test.ts
bun run oxlint --report-unused-disable-directives apps/server/src/orchestration/Layers/ProviderCommandReactorHelpers.ts apps/server/src/orchestration/Layers/ProviderCommandReactorInputExpansion.ts apps/server/src/orchestration/Layers/ProviderCommandReactorInputExpansion.test.ts apps/server/src/orchestration/Layers/ProviderCommandReactorSessionOps.context.test.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.largeInput.test.ts apps/server/src/provider/Layers/ProviderService.routing.cursor.test.ts apps/server/src/provider/Layers/ProviderService.sendTurn.largeInput.test.ts
bun run oxfmt --check apps/server/src/provider/Layers/OpencodeV2/Adapter.admission.ts apps/server/src/provider/Layers/OpencodeV2/Runtime.input.ts apps/server/src/provider/Layers/OpencodeV2/Runtime.admission.ts apps/server/src/provider/Layers/OpencodeV2/Runtime.attachments.ts apps/server/src/provider/Layers/OpencodeV2/Runtime.input.largeInput.test.ts apps/server/src/provider/Layers/OpencodeV2/Adapter.admission.largeInput.test.ts apps/server/src/provider/Layers/OpencodeV2/Runtime.attachments.test.ts
bun run oxlint --report-unused-disable-directives apps/server/src/provider/Layers/OpencodeV2/Adapter.admission.ts apps/server/src/provider/Layers/OpencodeV2/Runtime.input.ts apps/server/src/provider/Layers/OpencodeV2/Runtime.admission.ts apps/server/src/provider/Layers/OpencodeV2/Runtime.attachments.ts apps/server/src/provider/Layers/OpencodeV2/Runtime.input.largeInput.test.ts apps/server/src/provider/Layers/OpencodeV2/Adapter.admission.largeInput.test.ts apps/server/src/provider/Layers/OpencodeV2/Runtime.attachments.test.ts
```

Use the same explicit, nonempty code-file lists for `wc -l`, and fail review if any individual authored source/test exceeds 400 lines; totals are irrelevant. Update these lists for any additional task-owned split file. Do not use the root length script: its inspected implementation performs an unscoped test scan. Never pass an empty file list to the formatter. If formatting needs correction, run it only on explicit task-owned paths.

Final static verification: search production sources for the removed constant and classify the remaining 120000/120_000 literals in the inspected provider paths. Review the task diff to verify no unrelated bound, UI, setting, generated file, lockfile, or migration changed.

Package-wide typechecks above are the configured checks for affected packages, not workspace-wide checks. Report unrelated dirty-worktree failures separately. Any repository-/workspace-wide check requires fresh approval. Never run `bun test`; do not invoke unfiltered root `bun run test`, `bun lint`, or root typecheck.

### Plan-document validation

Only the saved plan is changed during planning. Check it with:

```sh
bun run oxfmt --check docs/plan/2026-11-11-provider-send-cap-recovery-budget-plan.md
```

Check metadata, code-path references, and command/test filename consistency manually. There are no external links requiring network verification. Implementation tests/typechecks are not applicable to this documentation-only delivery and must not be represented as run.

Planning validation: the initial focused formatting check found formatting differences; Oxfmt was applied only to this plan and the subsequent check passed. Manual metadata, path, and command/test-name review completed. The status fingerprint excluding this new plan still matched the initial fingerprint after formatting; unrelated work was unchanged.

## 9. Risks and rollout

- **Larger final prompts can hit native provider or existing transport limits.** That is intentional separation of responsibilities, not a promise of unlimited model capacity. Keep existing errors/recovery; do not add compensating universal thresholds.
- **History allowance semantics change.** Small current requests retain approximately the previous replay capacity; large current requests no longer consume it. Test the history prefix separately from final text and migrate all known callers in one task.
- **Expanded inputs change future request fingerprints.** Unchanged ordinary text and existing V2 immutable preparation/fingerprinting must remain byte-for-byte stable. Do not rewrite persisted admissions or retry ambiguous old requests with reconstructed payloads; existing mismatch/no-resend errors remain authoritative.
- **Existing attachment/media storage bounds can still reject very large attachment-bearing requests.** Keep them unchanged, state that limitation honestly, and use tests below those independent byte bounds.
- **Dirty checkout overlap:** Recheck each target before edits. Preserve unrelated changes, including nearby orchestration/contracts work. Stop and ask if ownership becomes unclear.
- **Rollout:** Normal code release after focused validation; no feature flag, database migration, UI release, or package upgrade.
- **Observability:** Existing service validation/provider errors and admission evidence suffice; do not log full prompts or add new telemetry for this task.
- **Rollback:** Revert only task-owned changes as a coherent unit so helper call sites and schema imports agree. Preserve other uncommitted work. Rollback restores old truncation/cap behavior and does not authorize replaying uncertain turns.

## 10. Plan validity

This plan describes branch `dev` at commit `f73faab0d38de32c6f3839bae1deb5d9763e6f92` plus the inspected dirty working tree, not a clean checkout. Read-only research left the status fingerprint unchanged. The saved plan is the sole intended planning change.

Relevant installed/project constraints: Bun package manager declaration `1.3.9`; Vitest `^4.0.0`; Oxfmt `^0.40.0`; Oxlint `^1.55.0`; Effect catalog `4.0.0-beta.43`; OpenCode client `2.1.4`. No dependency change or external research is required.

Revalidate if the branch/commit changes, any target changes concurrently, bootstrap gains callers, context composition or recovery eligibility changes, provider schemas move, or package scripts/test grouping differ. Revalidate targeted fixture side effects before running tests; do not use tests that create worktrees without approval. The plan intentionally makes no claim about a particular provider's current token window.

## 11. Handoff notes

- Implement in order: shared replay semantics and tests; reference expansion; schema cap removal; narrowly classified V2 duplicates; cross-boundary regression tests; focused checks. Keep the task coherent before release because removing the old constant requires migrating all consumers.
- Settled decisions: no replacement universal cap, no token estimation, current message preserved, replay independently bounded, existing provider/native resume exclusions unchanged, unrelated bounds retained, no UI/settings changes.
- The mandatory changes are only those in Section 7. Do not turn deferred ideas into implementation prerequisites.
- Requirement-coverage review and execution-readiness review were completed against the inspected call paths. They explicitly checked steering semantics, the hidden expansion truncation, all four V2 checks, generated replay framing, oversized current messages, mock-versus-real-service coverage, and the 400-line constraint.
- Independent-agent review was unavailable in this session's exposed tools; no delegation or independent-review result is claimed. The plan received two author review passes.
- **Remaining product questions/blockers:** None. Exact original failed-payload attribution is unavailable but is not needed to fix or test the confirmed structural mismatch. Implementation and validation remain to be performed.
