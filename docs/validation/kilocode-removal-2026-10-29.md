# KiloCode removal validation

Date: 29 October 2026. Branch: `feature/computer-use`. Checks below are scoped; pushing is excluded from the requested commit workflow.

## Result

The KiloCode harness is removed from active contracts, settings, runtime composition, discovery, terminal recognition, desktop/mobile selection, and current marketing. Independent Kilo gateway model data remains supported by other harnesses. Historical research and changelogs remain unchanged.

Saved KiloCode project/thread selections, options, sub-provider IDs, sessions, queued prompts, recovery and usage remain readable. Historical selections have an explicit stored schema separate from active routing. Existing chats display a provider-specific read-only notice; admission, bootstrap, queue, delegation, and sleep-recovery guards prevent restarting, automatically substituting providers, or rebinding saved sessions. The external CLI and user files are not uninstalled or deleted.

**Code green: Yes. Implementation/Plan green: Yes, within the focused validation scope recorded here.** The remaining mobile queue rejection-reason mismatch is resolved by reusing the shared orchestration rejection type in delivery state and its schema in persisted drafts. Queue rejection reasons now survive reconciliation and storage reloads. No broad checks were run.

## Focused checks

All commands run from the repository root unless `--cwd` specifies the package.

| Command / scope                                                  | Result                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run --cwd apps/server typecheck`                            | Passed final run; existing Effect informational suggestions remain.                                                                                                                                                                                                                                                                                                                                                                     |
| `bun run --cwd apps/web typecheck`                               | Passed.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `bun run --cwd packages/contracts typecheck`                     | Passed.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `bun run --cwd packages/shared typecheck`                        | Passed.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `bun run --cwd apps/marketing typecheck`                         | Astro checked 34 files; no errors/warnings.                                                                                                                                                                                                                                                                                                                                                                                             |
| `bun run --cwd scripts typecheck`                                | Passed; existing informational suggestions remain.                                                                                                                                                                                                                                                                                                                                                                                      |
| `bun run --cwd apps/desktop typecheck`                           | Passed.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `bun run --cwd apps/mobile-web typecheck`                        | Passed after the mobile rejection-reason compatibility fix.                                                                                                                                                                                                                                                                                                                                                                             |
| `node --check apps/desktop/scripts/connection-smoke.fixture.mjs` | Passed.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Explicit-path `oxfmt --check` / `oxlint`                         | Passed scoped formatter checks and lint with zero errors. Two existing warnings remain: `no-map-spread` in model response mapping and `preserve-caught-error` in the desktop fixture. The desktop fixture has one existing `preserve-caught-error` warning despite an explicit AggregateError cause; left untouched. Astro is not supported by the repository formatter and was checked through Astro and scoped whitespace validation. |
| Explicit source/test length scan                                 | All changed authored source/test files are at most 400 lines.                                                                                                                                                                                                                                                                                                                                                                           |
| Scoped `git diff --check -- <changed paths>`                     | Passed.                                                                                                                                                                                                                                                                                                                                                                                                                                 |

The exact 184 authored paths are recorded in [source-paths](kilocode-removal-2026-10-29.source-paths.txt); this list excludes unrelated work already present. Deleted Kilo-only adapter/provider modules, icon asset, and Kilo-only active-runtime tests are omitted from formatter inputs.

Reproduce formatter/lint checks with explicit paths from that manifest (excluding `.astro` for Oxc); do not invoke root `bun lint` or other broad checks.

## Focused regression evidence

| Scope                                                                                                                                     | Result                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server exact-path batch: `xargs bun run --cwd apps/server vitest run < docs/validation/kilocode-removal-2026-10-29.server-test-paths.txt` | Final main batch passed 48 files / 333 tests. Final settings and recovery additions passed separately: 3 files / 20 tests, including the new recovery test listed in the manifest. |
| Contracts                                                                                                                                 | 10 files / 76 tests passed: active rejection plus full read-model, project/thread preference, queued prompt, session/recovery, five domain event variants, and usage round trips.  |
| Shared                                                                                                                                    | 5 files / 71 tests passed, including provider lifecycle and runtime model guards.                                                                                                  |
| Web unit                                                                                                                                  | 16 files / 88 tests passed; parent also verified 5 focused files / 33 tests covering read-only history, materialization and thread actions.                                        |
| Web browser                                                                                                                               | 2 files / 10 tests passed.                                                                                                                                                         |
| Mobile                                                                                                                                    | 3 files / 22 tests passed; parent additionally verified 2 command/view files / 14 tests.                                                                                           |
| Scripts: `bun run --cwd scripts vitest run lib/sleep-wake-probe.test.ts lib/sleep-wake-probe.paths.test.ts`                               | 2 files / 17 tests passed.                                                                                                                                                         |

Actual database-to-wire history hydration is covered by `ProjectionSnapshotQuery.kilocodeHistory.test.ts`, not just an isolated selection codec. `serverSettings.opencodeV2.test.ts` exercises obsolete provider configuration, stale hidden-provider preferences and historical Kilo text-generation preferences through load, unrelated writes, and reload. `ProviderTurnSupervisor.kilocodeHistory.test.ts` proves old selections and session identities cannot resume or create new recovery work. Decider and session-policy tests cover read-only admission and replay without runtime calls.

An initial provider-family test invocation matched both `Opencode` and `OpencodeV2` by substring and was interrupted without claiming a result. Validation then used exact test paths. Earlier task-related failures were corrected and the affected checks rerun; no interrupted or failed run is counted as passed.

## Review

Independent final review marked research/plan, active removal, preserved history, provider-specific read-only behavior, settings compatibility, and focused regression evidence complete. No unresolved task defect was found. The mobile typecheck failure is resolved; the focused completion gates are green. No push was made.

## Mobile validation follow-up

The continuation changes only these four mobile files:

- `apps/mobile-web/src/lib/mobileCommandDelivery.logic.ts`
- `apps/mobile-web/src/lib/mobileCommandDelivery.test.ts`
- `apps/mobile-web/src/lib/mobileComposerDraft.ts`
- `apps/mobile-web/src/lib/mobileComposerDraft.test.ts`

`bun run --cwd apps/mobile-web typecheck` passed. `bun run --cwd apps/mobile-web vitest run src/lib/mobileCommandDelivery.test.ts src/lib/mobileComposerDraft.test.ts src/screens/MobileThread.commands.test.ts` passed 3 files / 20 tests, including new reconciliation and storage-reload regressions. Vitest emitted a non-failing Node local-storage path warning. Explicit-path Oxfmt and Oxlint passed with zero lint warnings/errors; the four files contain 107, 172, 358 and 198 lines respectively, below the 400-line limit. Scoped whitespace and document-link checks passed. Other packages retain their previously recorded checks; no repository-wide validation was performed.

## Commit preparation

The requested KiloCode removal and mobile compatibility fix were checked in an isolated checkout with unrelated workspace changes excluded. This includes the shared queue rejection reason schema and its command-receipt union required by the mobile fix; unrelated queue dispatch changes remain excluded.

- Server exact-path manifest: 49 files / 336 tests passed.
- Changed contracts tests: 5 files / 18 tests passed; shared: 2 files / 6 tests passed.
- Changed web unit tests: 14 files / 73 tests passed; browser: 2 files / 10 tests passed.
- Mobile delivery, draft storage and thread command tests: 3 files / 20 tests passed.
- Scripts sleep/wake tests: 2 files / 17 tests passed.
- Isolated contracts, shared, mobile, marketing, scripts and desktop package typechecks passed. Final server and web package typechecks against the complete selected commit also passed, with existing Effect informational suggestions.
- Explicit-path formatting, lint and length checks passed for 183 KiloCode source/test files and the six mobile/contract compatibility files. Lint has zero errors and two existing warnings in the KiloCode scope.

The source manifest was expanded during commit review to include six compatibility files omitted from the original manifest. The existing staged chart rename and unrelated workspace changes are excluded from the requested commit.
