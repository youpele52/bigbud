# create_thread model choice — validation ledger (2026-10-15)

Plan: `docs/plans/2026-10-15-create-thread-model-choice-plan.md` (Phases 0–4; Phase 5 deferred).
Worktree: `.claude/worktrees/create-thread-model-choice`, branch `feat/create-thread-model-choice`,
base `plan/terminal-rust-gpu-reliability` @ `6a6e27052`.

Never `bun test`; all runs below use Vitest via `bun run`.

## Phase 0 — rebase gate (no code)

- Base contains `9b49bed83` plus `cf2c96fd8`, `ddbfc06e5`, `6a6e27052` (`git merge-base --is-ancestor 9b49bed83 HEAD` → true).
- Citations in §3/§7 re-read against `6a6e27052`. All still point at the cited code; small line drift only
  (`server.providers.ts` ServerProvider at 171–209 ✓, ProviderModel at 45–57 ✓, `http.threadTools.ts:187-235` ✓,
  `ThreadOrchestrationTools.ts:27-245`, `:70-74`, `:150-187`, `:204,230` ✓, `deciderThreads.turn.start.ts:69-96`,
  `QueuedPromptPolicy.logic.ts:25-32,147-153`, `projectorThreadLifecycle.ts:339` ✓, `projector.ts:113-130` ✓).
- Line counts at the base: `ThreadOrchestrationTools.ts` 365, `copilotThreadOrchestrationTools.ts` 396,
  `ws/http.threadTools.ts` 394, `orchestration.commands.client.ts` 397, `orchestration.commands.internal.ts` 225,
  `ThreadWorkflowStatus.logic.ts` 313, `desktopSupervisorDelivery.ts` 399, `wsRpcContext.ts` 369,
  `ProjectionThreadActivities` layer 384, `ProjectionThreads` layer 390, `useSettings.ts` 304,
  `orchestration.thread.ts` 396.
- Latest migration: `128_ProjectionThreadsForkOrigin.ts`. No migration is needed (none added).
- Baselines: `thread-tools:manifest:check` exit 0; `git rev-parse HEAD:apps/server/src/provider/Layers/OpencodeV2`
  = `a56be2b3d56a09dc9be5d0cc8c8c9c070425fec1`.
- Assumptions: A1 ✓ (`getProviders` reads the cached snapshot ref; `refresh` is separate), A2 ✓ (only
  `unauthenticated` is excluded), A3 ✓ (custom models are in snapshot `models`, `isCustom: true`),
  A4 ✓ for live clients (`thread.created` inserts a full thread shell; `thread.activity-appended` updates it),
  A5 ✗ partially (see deviation D-3), A6 ✗ partially on the server (see deviation D-2).

## Phase 1 — delegation domain extension (ships dark)

Red → green:

| Test                                                                          | Red (before code)                        | Green |
| ----------------------------------------------------------------------------- | ---------------------------------------- | ----- |
| `packages/contracts … orchestration.delegationModelChoice.test.ts`            | exit 1, module not found                 | 4/4   |
| `packages/shared … delegatedModelChoice.test.ts`                              | exit 1, module not found                 | 5/5   |
| `apps/server … deciderThreads.delegationModelChoice.test.ts`                  | exit 1, 9 failed (unknown command types) | 9/9   |
| `apps/server … OrchestrationEngine.prepareCommandState.test.ts` (2 new cases) | 2 failed (`operational` loaded)          | 7/7   |

Gate commands (all exit 0):

- `bun run --cwd packages/contracts vitest run src/orchestration/orchestration.delegationModelChoice.test.ts` — 4 passed.
- `bun run --cwd packages/shared vitest run src/delegatedModelChoice.test.ts` — 5 passed.
- `bun run --cwd apps/server vitest run src/orchestration/deciderThreads.delegationModelChoice.test.ts src/orchestration/ThreadDispatchSafety.logic.test.ts src/orchestration/ThreadWorkflowStatus.logic.test.ts src/orchestration/Layers/OrchestrationEngine.prepareCommandState.test.ts src/orchestration/deciderThreads.turn.queue.test.ts src/orchestration/deciderThreads.turn.start.dispatchSafety.test.ts src/orchestration/deciderThreads.fork.test.ts src/orchestration/decider.opencodePolicy.test.ts` — 8 files, 93 passed.
- Extra regressions: `commandDigest`, `commandInvariants`, `decider.turn.start`, `Normalizer`, `deciderThreads.turn.queue.{admission,control}` — 6 files, 31 passed; full contracts suite 35 files, 206 passed.
- `bun fmt` 0, `bun fmt:check` 0, `bun lint` 0, `bun typecheck` 0 (9/9 tasks).
- `bun run --cwd apps/server thread-tools:manifest:check` 0; no change under `provider/Layers/OpencodeV2/`.
- Line counts: every new/edited code file ≤ 400 (`orchestration.commands.client.ts` exactly 400).

## Phase 2 — `create_thread` model choice, settings, presence, supervision

Red → green (red recorded before the implementation unless noted):

| Test                                                                      | Red                                                                                       | Green |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----- |
| `packages/contracts … core/settings.delegatedModelChoice.test.ts`         | 2 failed (fields missing)                                                                 | pass  |
| `apps/server … desktopSupervisorDelivery.presence.test.ts`                | 3 failed (`hasOpenConsumer` missing)                                                      | 3/3   |
| `apps/server … ThreadOrchestrationTools.modelChoice.test.ts`              | exit 1, module not found                                                                  | 23/23 |
| `apps/server … persistence/Layers/ProjectionThreads.modelChoice.test.ts`  | repository methods missing                                                                | 2/2   |
| `apps/server … ThreadOrchestrationTools.createThread.modelChoice.test.ts` | exit 1, module not found                                                                  | 7/7   |
| `apps/web … hooks/useSettings.storage.test.ts` (2 new cases)              | migration export missing                                                                  | 8/8   |
| `apps/server … ws/http.threadTools.modelChoice.test.ts`                   | first red was infrastructure (missing `NodeHttpServer.layerTest`), not a behavior failure | pass  |

Written after the implementation (no recorded red): `ThreadOrchestrationTools.listAvailableModels.test.ts`
(4/4, includes a spy proving `refresh` is never called), `ThreadWatchReactor.modelChoice.test.ts` (4/4, TestClock:
timer expiry, resolved interrupts, startup sweep for past and future deadlines),
`DelegatedThreadsSettingsSection.test.tsx` (3/3), and one `get_thread_status` case (requested vs used; the
status field itself was red → green in Phase 1).

Gate commands (all exit 0):

- §8.2 set plus the new files: `bun run --cwd apps/server vitest run src/orchestration-tools/ThreadOrchestrationTools.modelChoice.test.ts src/orchestration-tools/ThreadOrchestrationTools.createThread.test.ts src/orchestration-tools/ThreadOrchestrationTools.createThread.modelChoice.test.ts src/orchestration-tools/ThreadOrchestrationTools.listAvailableModels.test.ts src/orchestration-tools/ThreadOrchestrationTools.restart.test.ts src/orchestration-tools/ThreadOrchestrationTools.getThreadStatus.test.ts src/orchestration/Layers/ThreadWatchReactor.modelChoice.test.ts src/desktop-supervisor/desktopSupervisorDelivery.test.ts src/desktop-supervisor/desktopSupervisorDelivery.presence.test.ts src/ws/http.threadTools.test.ts src/ws/http.threadTools.modelChoice.test.ts src/ws/serverSettings.test.ts src/persistence/Layers/ProjectionThreads.modelChoice.test.ts` — 13 files, 92 passed.
- Wider regressions: `bun run --cwd apps/server vitest run src/desktop-supervisor src/orchestration-tools src/persistence src/retention src/ws src/orchestration/Layers/OrchestrationEngine.queuedPromptRecovery.test.ts src/orchestration/Layers/OrchestrationReactor.test.ts src/orchestration/Layers/ProviderRuntimeIngestion.reconcile.test.ts src/orchestration/projector.fork.test.ts src/server.mobile.ws.test.ts src/server.mobile.recovery.test.ts` — 244 files, 823 passed.
- Web: `bun run --cwd apps/web vitest run src/components/settings/DelegatedThreadsSettingsSection.test.tsx src/components/settings/ComposerProvidersSettingsSection.test.tsx src/components/settings/ThreadRetentionSettingsSection.test.tsx src/hooks/useSettings.storage.test.ts src/components/settings/SettingsSearch.logic.test.ts` — 5 files, 25 passed.
- Contracts: `settings.delegatedModelChoice.test.ts` + `settings.test.ts` — 2 files, 24 passed.
- `bun fmt` 0, `bun lint` 0, `bun typecheck` 0 (9/9 tasks; the TS29 messages printed are pre-existing, none in edited files).
- `bun run --cwd apps/server thread-tools:manifest:check` 0; no change under `apps/server/src/provider/Layers/OpencodeV2/`.
- Line counts: every new/edited code file ≤ 400 (largest: `desktopSupervisorDelivery.ts` 399, `desktopSupervisorDelivery.test.ts` 396, `ProjectionThreads.ts` 392).
- Retry fix: every command and the linked activity use `delegation.createdAt`; the create-thread fixture pins `createdAt`, and the retry-from-`thread_accepted` case reuses the stored decision with no conflict.
- Deviations: D-5 (sweep without the 1 h cutoff), D-6 (settings section placement).

## Phase 3 — web notice, picker, trunk card

Red → green:

| Test                                                                                   | Red                                     | Green |
| -------------------------------------------------------------------------------------- | --------------------------------------- | ----- |
| `apps/web … logic/session/session.activity.modelChoice.logic.test.ts` (incl. work log) | exit 1, module not found                | 4/4   |
| `apps/web … components/chat/view/ThreadModelChoiceNotice.logic.test.ts`                | exit 1, module not found                | 6/6   |
| `apps/web … stores/main/helpers.delegatedChildren.store.test.ts` (1 new case)          | 1 failed (no mirror)                    | 2/2   |
| `apps/web … stores/main/events.store.delegations.test.ts` (1 new case, +1 later)       | 1 failed (summary not read)             | 4/4   |
| `apps/web … components/chat/view/ThreadRecoveryNotice.clock.test.ts` (1 new case)      | 1 failed (`observeModelChoice` missing) | 3/3   |

Written after the components (no recorded red): `ThreadModelChoiceNotice.browser.tsx` (5/5: polite blue
status, countdown on the browser clock despite an hour-old server timestamp, 12 options + Show all, pick
dispatch and disabled-while-in-flight, green and amber lines, 375 px viewport without overflow) and
`DelegatedChildrenCard.browser.tsx` (2/2: pending row countdown opens the same picker and picks for the child;
green/amber resolved model; "Requested X" after a reload). The first browser run failed 2 tests because
multi-second countdowns need one fake-timer step per second (each render schedules the next tick); the tests
now step per second.

Gate commands (all exit 0 unless noted):

- `bun run --cwd apps/web vitest run` — 478 files, 2959 passed (includes the §8.3 unit files).
- `bun run --cwd apps/web test:browser src/components/chat/view/ThreadModelChoiceNotice.browser.tsx src/components/chat/agents/DelegatedChildrenCard.browser.tsx src/components/chat/view/ThreadRecoveryNotice.browser.tsx` — 3 files, 10 passed.
- `bun run --cwd packages/shared vitest run` — 50 files, 372 passed.
- `bun fmt` 0, `bun lint` 0 (no warnings in files touched by this work), `bun typecheck` 0 (9/9).
- Pre-existing, unrelated: `SettingsPanels.browser.tsx` "ProvidersSettingsPanel route expansion" fails 2 tests; reproduced
  identically at the base `6a6e27052` (detached checkout of a temporary WIP commit, then restored).
- Composer (item 4): the hold uses the standard queued-prompt event, so the held message appears in the composer queue
  like any queued prompt; no web change.
- Line counts: every new/edited code file ≤ 400 (largest `app.types.ts` 280).
- Manual check §8.4 (live providers, kill-and-restart, closed clients): **not performed** (no live provider session in
  this environment); covered only by the automated tests above.
- Deviations: D-7 (web-only card mirror), D-8 (copy uses model ids; countdown excluded from the live region).

## Phase 4 — tool surface in the non-V2 bridges

Red → green (tests written first):

| Test                                                                                    | Red                                       | Green |
| --------------------------------------------------------------------------------------- | ----------------------------------------- | ----- |
| `apps/server … codexThreadDynamicTools.modelChoice.test.ts`                             | 2 failed (no shared schema, no list tool) | 3/3   |
| `apps/server … copilotThreadOrchestrationTools.modelChoice.test.ts`                     | 3 failed                                  | 3/3   |
| `apps/server … orchestrationMcpBridge.modelChoice.test.ts` (spawns the rendered bridge) | 3 failed                                  | 3/3   |
| `apps/server … PiOrchestrationBridge.test.ts` (1 new case)                              | 1 failed                                  | 4/4   |
| `apps/server … ProviderCommandReactorSessionOps.threadContext.test.ts` (1 new case)     | 1 failed                                  | 5/5   |
| `apps/server … capabilities/CapabilityCatalog.test.ts` (1 new case)                     | 1 failed                                  | pass  |

The red run recorded 11 failed / 13 passed across the 6 files. While going green, 4 more failures appeared and were fixed
in the implementation or as expected test updates: the LP summary budget (short `summary` on the two tracks), the search
ranking for "create delegated child thread" (track wording), the MCP test's `maxLength` literal (now the shared JSON
schema), the Pi `execute` signature, and the Claude `allowedTools` list (new read-only tool). `OpencodeV2/
Orchestration.implementation.test.ts` then failed because V2's frozen specs must equal the Codex base surface; resolved
without touching V2 by keeping the v1 surface as the Codex default (deviation D-9).

Gate commands (all exit 0):

- §8.5 plus neighbours: `bun run --cwd apps/server vitest run src/orchestration-tools src/capabilities src/orchestration/Layers/ProviderCommandReactorSessionOps src/orchestration/Layers/ProviderCommandReactor src/provider/Layers/Copilot src/provider/Layers/Codex src/provider/Layers/OpencodeV2 src/provider/Layers/Pi src/provider/Layers/Claude src/provider/Layers/Opencode src/ws` — 468 files passed, 30 skipped (pre-existing native/integration skips); 2002 tests passed, 40 skipped. Includes `codexThreadDynamicTools`, `copilotThreadOrchestrationTools`, `orchestrationMcpBridge`, `orchestrationMcpBridge.allowedTools`, `PiOrchestrationBridge`, `mcpInvocationIdentity.integration` and `CapabilityCatalog`.
- `bun run --cwd apps/server thread-tools:manifest:check` 0; no change under `apps/server/src/provider/Layers/OpencodeV2/`.
- `bun fmt` 0, `bun lint` 0, `bun run --cwd apps/server typecheck` 0.
- Line counts: every new/edited code file ≤ 400 (`copilotThreadOrchestrationTools.ts` 396 → 148 after the split; largest edited `Claude/Adapter.test.ts` 380).
- Deviations: D-9 (v1 surface frozen, Codex opts in), D-10 (lenient `modelSelection` schema), D-11 (pre-approval and catalog wording, Copilot split).

## Full gate (after Phase 4)

Load before the run: `uptime` 1/5/15-minute averages 25.14 / 13.04 / 9.96 (high; other sessions active); after: 9.39 /
13.85 / 13.47. No file timed out, so no single-file rerun was needed.

| Command                      | Exit | Result                                  |
| ---------------------------- | ---- | --------------------------------------- |
| `bun fmt:check`              | 0    | clean                                   |
| `bun lint`                   | 0    | 0 errors; test file length check passed |
| `bun typecheck`              | 0    | 9/9 tasks                               |
| `bun run test -- --continue` | 0    | 9/9 tasks                               |

Per-package tests (`bun run test`): contracts 36 files / 208 tests; scripts 24 / 131; desktop 72 passed + 3 skipped files,
429 passed + 6 skipped tests; mobile-web 41 / 212; shared 50 / 372; web 478 / 2959; server 1154 passed + 45 skipped
files, 5056 passed + 104 skipped tests.

Browser tests are not part of `bun run test`; the ones touched by this work pass (see Phase 3). The pre-existing
`SettingsPanels.browser.tsx` failure (2 tests) reproduces at the base and is unrelated.

## Acceptance criteria (self-review, AC12 deferred with Phase 5)

| AC   | Status     | Evidence                                                                                                                                          |
| ---- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1  | Met        | Codex (opt-in, D-9), Copilot, MCP (Claude, Cursor, Devin, Codex-remote, ACP-remote) and Pi bridge tests; output `modelChoice`; no-input path test |
| AC2  | Met        | `createThread.modelChoice` immediate-start test                                                                                                   |
| AC3  | Met (auto) | hold tests, `refresh` spy, picker/countdown browser tests; manual §8.4 check not performed                                                        |
| AC4  | Met        | no-client, no-alternatives and `"parent"` cases in `modelChoice` tests                                                                            |
| AC5  | Met        | `ThreadWatchReactor.modelChoice` (timer, startup sweep past/future, 30 s sweep); history hydration (D-2)                                          |
| AC6  | Met        | every reason in `ThreadOrchestrationTools.modelChoice.test.ts`                                                                                    |
| AC7  | Met        | `list_available_models` in every AC1 bridge; read-only; ranked usable models                                                                      |
| AC8  | Met        | resolved activity, `get_thread_status.modelChoice`, notice and trunk card (reload shows only the request, D-7)                                    |
| AC9  | Met        | stored decision reused on retry; deterministic `createdAt`                                                                                        |
| AC10 | Met        | Phase 1 decider tests (user messages queue; `threadHasStarted` unchanged)                                                                         |
| AC11 | Met        | no new top-level folder, event type or migration; nothing under `OpencodeV2/` changed; manifest check unchanged                                   |
| AC12 | Deferred   | Phase 5 (separate release)                                                                                                                        |
| AC13 | Met        | full gate above; every added or materially edited code file ≤ 400 lines                                                                           |

Known limits: the mobile app's command allowlist does not include `thread.delegation.model-choice.pick`. Since the
review fixes (D-16), a mobile-only client no longer counts as connected, so it falls back immediately; follow-up:
mobile-web picker plus allowlist. Provider
sessions started before the upgrade keep their old tool schemas until restart (plan Phase 4 item 4).

## Review fixes (2026-10-15)

Each behavior finding got a test that failed first. The fix landed only after the red run was recorded. Plan §12 records
D-12–D-19, and §11 adds the three accepted items and the mobile follow-up.

| Finding     | Test (red first)                                                                       | Red output                                                                          | Green |
| ----------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----- |
| H1          | `OrchestrationEngine.modelChoiceRecovery.test.ts`                                      | held prompt flushed at startup as a `queue-message:…` turn, not `delegated-message` | 1/1   |
| H1          | `ProjectionOperationalStateQuery.modelChoice.test.ts` (fix reverted for the red run)   | `expected false to be true` (hold missing from the startup and per-thread window)   | 2/2   |
| M2          | `deciderThreads.delegationModelChoice.recovery.test.ts`                                | `promise resolved "[]" instead of rejecting`                                        | 38/38 |
| L7          | same file                                                                              | flush used the fallback `codex/gpt-5`, not the picked `claude-sonnet`               | 38/38 |
| M3          | `useSettings.storage.test.ts`                                                          | `expected 'dropped' to be 'migrated'`; `expected 'migrated' to be 'failed'`         | 10/10 |
| M4, L6      | `ProjectionThreads.modelChoice.test.ts`                                                | `expected [ 'o1', 'd0' ]` (old and deleting rows returned)                          | 3/3   |
| M4, L6      | `ThreadWatchReactor.modelChoice.test.ts`                                               | `expected 100 to equal 150` (one page per sweep)                                    | 5/5   |
| M5 (and L8) | `server.mobile.presence.ws.test.ts` (mobile subscriber vs `hasOpenConsumer()`)         | `[ false ]` expected, `[ true ]` received                                           | 8/8   |
| L5          | `ThreadOrchestrationTools.createThread.modelChoice.test.ts` (`null`, `{}` vs no input) | 2 failed: child-linked activity gained `modelChoice: { status: "pending" }`         | 9/9   |
| L9          | `Codex/Adapter.test.ts` (opt-in flipped to `false` for the red run, then restored)     | `expected [ 'list_notes', … ] to include 'list_available_models'`                   | 3/3   |
| L10         | `ThreadModelChoiceNotice.logic.test.ts`                                                | 3 failed: raw `\u202E`/newline text; `function Object() { [native code] }`          | 9/9   |

Accepted without code change (plan §11): a retry reuses the stored decision after settings change; the agent learns
provider availability and recency (no secrets); runtime-mode guardrail parity is a pre-existing follow-up.

Gates after the review fixes (2026-10-15): `bun fmt` 0; `bun lint` 0 (0 errors, no new warnings in touched code);
`bun typecheck` 0 (9/9); `bun run --cwd apps/server thread-tools:manifest:check` 0; `OpencodeV2/` tree hash unchanged
(`a56be2b3d…`); focused server suites 84 files / 408 tests, web 23 / 138, browser notice and card 2 / 7. Full
`bun run test -- --continue` exit 0 (9/9 tasks): contracts 208, scripts 131, desktop 429 + 6 skipped, mobile-web 212,
shared 372, web 2964, server 5065 + 104 skipped. Every touched code file is ≤ 400 lines (`server.mobile.ws.test.ts`
split into `server.test.mobile.ts` helpers and `server.mobile.presence.ws.test.ts`).

## Review fixes, round 2 (2026-10-16)

| Finding                 | Test (red first)                                                                       | Red output                                                                                        | Green |
| ----------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----- |
| #1 startup plan         | `ProjectionOperationalStateQuery.modelChoice.test.ts` (old predicate swapped back)     | `expected 'SEARCH r USING INDEX idx_projection_t…' to not include 'projection_thread_activities'` | 3/3   |
| #2 ambiguous hold       | `OrchestrationEngine.modelChoiceHoldFailure.test.ts` (committed and rejected, retried) | `expected [ 'delegated-message' ] to not include 'delegated-message'` (sent and still queued)     | 2/2   |
| #3 over-age hold        | `ProjectionThreads.modelChoice.test.ts` (old `since` passed for the red run)           | `expected [ 'c1', 'n1' ] to deeply equal [ 'o1', 'c1' ]` (over-age `o1` stranded)                 | 3/3   |
| #4 concurrent settings  | `useSettings.storage.test.ts`                                                          | `expected { terminalFontSize: 13 } to deeply equal { terminalFontSize: 18 }`                      | 11/11 |
| #5 provider-less object | `createThread.modelChoice.test.ts` (`{provider:null}`, `""`, `"   "`, `{model}`)       | 4 failed: each produced a pending hold                                                            | 13/13 |

**Query plan (#1).** The evidence comes from a temporary benchmark (not committed) on an in-memory, fully migrated database (SQLite
3.51.1, the version `node:sqlite` uses). It held 20,000 activities on one held thread, 20,000 on a resolved one and 300
threads × 100 activities, with 100 resolved and 3 pending holds. The after queries ran three times each (all runs shown); the
before query ran once.

| Query             | Before                                                                                      | After                                                                                                     | Rows      |
| ----------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------- |
| Startup window    | 48,723 ms; `CORRELATED SCALAR SUBQUERY` → `SEARCH r/v USING INDEX …thread_sequence` per row | 62–63 ms; `MATERIALIZE model_choice_unresolved` via `…kind_created`, `AUTOMATIC COVERING INDEX` anti-join | 404 / 404 |
| Per-thread window | 11.4 ms (correlated per requested row)                                                      | 9.3 ms (same materialized CTEs)                                                                           | 101 / 101 |

The only correlated subqueries left in the startup plan are the pre-existing pending-approval and user-input lookups,
which use their own indexes. The committed test asserts that no correlated subquery searches
`projection_thread_activities`.

Gates after round 2 (2026-10-16): `bun fmt` 0; `bun lint` 0 (0 errors; only the pre-existing `makeStorage` warning in a
touched file); `bun typecheck` 0 (9/9); `thread-tools:manifest:check` 0; nothing under `OpencodeV2/` changed; focused
server 76 files / 380 tests, contracts 98, web 32. Full `bun run test -- --continue` exit 0 (9/9 tasks): contracts 208,
scripts 131, desktop 429 + 6 skipped, mobile-web 212, shared 372, web 2965, server 5073 + 104 skipped. Every touched
code file is ≤ 400 lines.

## Round 3 review fix (2026-10-16)

| Finding                                                                                                                                                                                        | Fix                                                                                                                                                                                                   | Evidence                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MEDIUM: lazy per-thread activity load built the global model-choice CTEs (a filter outside a `MATERIALIZED` CTE cannot reach inside), scanning every model-choice activity on each thread load | `unresolvedModelChoiceRequestsCtes(sql, threadId?)` scopes both CTEs to the thread; `ProjectionOperationalStateQuery.threadSql.ts` passes `threadId`. Startup window and sweep stay global by design. | New plan test "scopes the per-thread model-choice CTEs to the loaded thread": red with the unscoped call (`expected 'SEARCH projection_thread_activities U…' to include 'thread_id=?'`), green scoped. Related suites 5 files / 14 tests pass. |
