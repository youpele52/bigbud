# Validation ledger: Claude Agent SDK 0.3.301 and provider subagent display

**Date:** 16 October, 2026
**Plan:** [2026-10-16-claude-agent-sdk-and-subagent-display-plan.md](../plans/2026-10-16-claude-agent-sdk-and-subagent-display-plan.md)
**Branch / worktree:** `feat/claude-sdk-subagent-display` in `.claude/worktrees/claude-sdk-subagent-display`, starting at `4a1661223b`.
**Constraints:** no live Claude run (D2); no real provider sessions against `~/.bigbud`; `bun test` never used.

## Pre-flight reference verification (HEAD `4a1661223b`)

| Reference                                       | Plan claim                    | At HEAD |
| ----------------------------------------------- | ----------------------------- | ------- |
| `Adapter.tasks.reducer.ts`                      | 414 lines                     | 414     |
| `ProviderRuntimeIngestion.processor.runtime.ts` | 419 lines                     | 419     |
| `Adapter.utils.ts`                              | 430 lines                     | 430     |
| `orchestration.thread.ts`                       | 396 lines                     | 396     |
| `Adapter.stream.system.ts`                      | 395 lines                     | 395     |
| `ProjectionCatalogQuery.detail.ts`              | 396 lines                     | 396     |
| `events.store.threads.runtime.ts`               | 379 lines                     | 379     |
| `apps/server/package.json:33`                   | SDK pinned `0.3.293`          | matches |
| npm dist-tags                                   | `latest` = `next` = `0.3.301` | matches |

## Phase 1: SDK upgrade to 0.3.301

- `bun install`: lockfile diff limited to `@anthropic-ai/claude-agent-sdk` and its eight native optional packages (11 lines changed). Installed version: 0.3.301.
- Red: after updating `CLAUDE_AGENT_SDK_VERSION`, `bun run --cwd apps/server vitest run src/provider/Layers/Claude/Adapter.sdk.routing.test.ts` failed 1/2 (`expected { sdkVersion: '0.3.301' } to deeply equal { sdkVersion: '0.3.293' }`). Green after updating the assertion.
- No type breaks.

| Command                                                                                        | Exit | Result                                                                       |
| ---------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------- |
| `bun run --cwd apps/server vitest run src/provider/Layers/Claude src/provider/Layers/CliProxy` | 0    | 57 files passed, 3 skipped; 264 tests passed, 3 skipped (live smoke, opt-in) |
| `bun fmt`                                                                                      | 0    |                                                                              |
| `bun lint`                                                                                     | 0    |                                                                              |
| `bun typecheck`                                                                                | 0    | 9/9 tasks                                                                    |

## Phase 2: Provider-neutral subagent model and display

Red → green:

- Contracts: with the `...OrchestrationSubagentFields` spread temporarily removed from `TaskUpdatedPayload`, `providerRuntime.payloads.tasks.test.ts` failed 2/6 (new fields stripped; more than 5 steps accepted). Green with the spread: 6/6.
- Shared: `providerSubagents.test.ts` failed to import before the module existed (`Cannot find module './providerSubagents'`). Green: 8/8.
- Throttle: `ProviderRuntimeIngestion.subagentThrottle.test.ts` failed to import before the module existed. Green: 5/5.
- Ingestion: `ProviderRuntimeIngestion.subagents.test.ts` run against the HEAD ingestion files (temporarily restored) failed 3/5 (display fields dropped; no throttle; no flush). Green with the new files: 5/5. The reopen test first failed against the new code too (`endedAt` survived the projector merge), which led to deviation 2.3 below.
- Web store: `events.store.providerAgents.test.ts` failed 3/5 (`upsertProviderAgent is not a function`). Green: 5/5.
- Clock: `chat-view-agent-activity.logic.test.ts` failed 2/4 (`shouldTickElapsedClock is not a function`). Green: 4/4.
- Hierarchy: `SubagentsCard.test.tsx` failed 1/3 (a child linked by `parentTaskId` was not nested). Green: 3/3.
- Presentation logic: `subagentPresentation.logic.test.ts` was written before the module existed. Its red run was not captured. Green: 7/7.
- Fork: `deciderThreads.fork.test.ts` passed on the first run (7/7). `copyForkTasks` already copies unknown fields through `...rest`, so this is a regression lock, not a red → green.

| Command                                                                                                                                                                                                                                                                                                                                                                       | Exit      | Result                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------- |
| `bun run --cwd packages/contracts vitest run src/orchestration/providerRuntime.payloads.tasks.test.ts`                                                                                                                                                                                                                                                                        | 0         | 6 passed                                                |
| `bun run --cwd packages/shared vitest run src/providerSubagents.test.ts`                                                                                                                                                                                                                                                                                                      | 0         | 8 passed                                                |
| `bun run --cwd apps/server vitest run src/orchestration/Layers/ProviderRuntimeIngestion.processor.events.test.ts src/orchestration/Layers/ProviderRuntimeIngestion.subagentThrottle.test.ts src/orchestration/Layers/ProviderRuntimeIngestion.subagents.test.ts src/orchestration/Layers/ProjectionCatalogQuery.detail.test.ts src/orchestration/deciderThreads.fork.test.ts` | 0         | 5 files, 25 tests                                       |
| `bun run --cwd apps/server vitest run src/orchestration/Layers/ProviderRuntimeIngestion src/orchestration/Layers/ProjectionCatalogQuery.detail.test.ts src/orchestration/deciderThreads.fork.test.ts src/orchestration/projector src/orchestration/Layers/ProjectionPipeline`                                                                                                 | 0         | 54 files, 183 tests                                     |
| `bun run --cwd apps/web vitest run src/components/chat/agents src/components/chat/view/chat-view src/components/chat/messages/MessagesTimeline.logic.test.ts src/stores/main`                                                                                                                                                                                                 | 0         | 30 files, 137 tests                                     |
| `bun run --cwd apps/web test:browser src/components/chat/agents/SubagentsCard.browser.tsx`                                                                                                                                                                                                                                                                                    | 0         | 3 passed (375 px, 1280 px, nesting)                     |
| `bun fmt` / `bun lint` / `bun typecheck`                                                                                                                                                                                                                                                                                                                                      | 0 / 0 / 0 | lint: 0 errors; its warnings are all in untouched files |

Every touched code file is 400 lines or fewer. The largest is `ProviderRuntimeIngestion.processor.runtime.ts` at 385, down from 419.

## Phase 3: Claude subagent fidelity

Red → green:

- Decoders: `Adapter.sdk.messages.tasks.test.ts` failed 2/7 before the 0.3.301 fields were decoded. Green: 7/7.
- Fixture replay (`fixtures/sdk-0.3.301-subagent-messages.json`, hand-written from the 0.3.301 `sdk.d.ts` and `sdk-tools.d.ts`; D2): `Adapter.stream.subagents.replay.test.ts` run against the Phase 2 Claude adapter files (temporarily restored from HEAD) failed 3/5: models, steps and metrics missing; context meter moved; child partial leaked. The ambient and CLIProxy cases passed vacuously, because HEAD never classified `local_agent`. Green: 5/5.
- Frame behavior: `Adapter.stream.subagents.test.ts` against the same HEAD files failed 8/8: `agent_id` correlation and the 5-step ring; forwarded-text gating; late runs; reopen; `worker_restart`; heartbeat; legacy `agent`; usage → metrics. Green: 8/8.
- Duplicate lifecycle upserts (3.10): `ProviderRuntimeIngestion.processor.events.test.ts` failed 3/8 (`isDuplicateClaudeLifecycleUpsert is not a function`). Green: 8/8. A harness-level version was dropped, because the projector already rejects the cross-epoch lifecycle snapshot, so projected state could not show the skip.
- Classification unit tests (`Adapter.tasks.classify.test.ts`, 18 cases) were written after the classifier, so they have no captured red. The behavior is also covered red → green by the replay and frame tests above.
- Tests that pinned the old defects were changed deliberately:
  - the `task_progress` → `thread.token-usage.updated` test was inverted into the context-meter regression and moved out of `Adapter.lifecycle.test.ts` (402 → 344 lines);
  - the routing sequence no longer contains `thread.token-usage.updated`;
  - the modern plan test now uses `local_bash` (D8);
  - the forwarded-text test enables `forwardedSubagentText`.

| Command                                                                                                                                                                                                                                       | Exit      | Result                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------- |
| `bun run --cwd apps/server vitest run src/provider/Layers/Claude src/provider/Layers/CliProxy src/orchestration/Layers/ProviderRuntimeIngestion.processor.events.test.ts src/orchestration/Layers/ProviderRuntimeIngestion.subagents.test.ts` | 0         | 62 files passed, 3 skipped; 303 tests passed, 3 skipped (opt-in live smoke) |
| `bun run --cwd apps/server thread-tools:manifest:check`                                                                                                                                                                                       | 0         | unchanged                                                                   |
| `bun fmt` / `bun lint` / `bun typecheck`                                                                                                                                                                                                      | 0 / 0 / 0 | lint back to the 31-warning baseline (none in touched files)                |

Note: one earlier run of `ProviderRuntimeIngestion.subagents.test.ts` hung for more than 15 minutes, under load average 8–15, while a since-removed Pi `turn.completed` test case was in the file. I stopped my own process (no user process was signalled). The file without that case passes (18/18 together with the throttle and events tests).

## Phase 4: OpenCode V2 read-only observer (G4 not passed)

Red → green:

- New tests `Runtime.subagents.test.ts` and `EventHub.children.test.ts`, run against the HEAD `EventHub.ts`, `Runtime.ts` and `Runtime.recovery.ts` (temporarily restored, then put back): 7/11 failed. The observer never ran (no `task.updated`, `session.list` never called), the hint never reached the owner (`onChildHint` called 0 times), and `hub.noteChildren is not a function`. The 4 that passed are the pure index test, the throwing-hint test, the inert case and the G4 denial guard, which do not depend on the wiring. Green: 11/11.

G4 outcome: not passed; V2 native subagents stay denied (D1). Evidence: [opencode-v2-subagent-evidence-2026-10-16.md](opencode-v2-subagent-evidence-2026-10-16.md).

| Command                                                                                                                                  | Exit      | Result                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------ |
| `bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2 src/orchestration/Layers/ProviderCommandReactorSessionOps.recovery` | 0         | 218 files passed, 27 skipped; 944 tests passed, 37 skipped (native and live opt-in suites) |
| `bun run --cwd apps/server thread-tools:manifest:check`                                                                                  | 0         | unchanged                                                                                  |
| `bun run --cwd apps/server thread-tools:native-qualification:check`                                                                      | 0         | `generatorSourceDigest` 3321f844…a31, `qualifiedRecords` 0 (unchanged)                     |
| `bun fmt` / `bun lint` / `bun typecheck`                                                                                                 | 0 / 0 / 0 | lint at the 31-warning baseline (none in touched files)                                    |

Load average was 64–112 during the run; no timeouts.

## Phase 5 (widened): every registered provider, capability contract

Red → green (tests written from SDK/protocol declarations; no live runs):

- Copilot (`Adapter.mapEvent.subagents.test.ts`, shapes from `@github/copilot-sdk` 1.0.7 `session-events.d.ts`): against the HEAD mapping, the model/steps/metrics and failure/end-time tests failed (2/3; the third, an unknown-step and no-agent guard, passes at HEAD by design). Green: 3/3.
- Pi (`Adapter.stream.subagents.fields.test.ts`, shapes from the 0.80.3 extension and pi-ai `ToolCall`/`toolResult`): 3/4 failed at HEAD (model, prompt, steps, metrics, result summary, end time, async tool-count metrics and step ring). Green: 4/4.
- OpenCode V1 / KiloCode (`Adapter.stream.children.fields.test.ts`, `@opencode-ai/sdk` 1.17.13 v2 types): 2/3 failed at HEAD (`tracksChildSessions is not a function`; KiloCode identity, model, summed metrics, tool steps). Green: 3/3.
- Codex (`Adapter.stream.subagents.test.ts`, shapes from `codex app-server generate-ts` 0.162.1 `ThreadItem`): failed at HEAD with "Cannot find module './Adapter.stream.subagents.ts'" (Codex mapped nothing). Green: 5/5, plus the adapter wiring test (`Adapter.stream.subagents.adapter.test.ts`, 1/1).
- Conformance (`providerSubagents.conformance.test.ts`): failed while Codex had no mapping test ("codex: missing provider/Layers/Codex/Adapter.stream.subagents.test.ts"), and again when a KiloCode test file lacked `providerSubagent` assertions. With Devin's `capabilities.subagents` removed temporarily it failed ("provider/Layers/Devin/Adapter.ts: expected +0 to be 1"). Green: 3/3.
- Web: `SubagentsCard.agnostic.test.ts` (no provider branches in the Subagents display) is a guard and passes.
- Tests changed deliberately: the Claude and CLIProxy capability assertions now include `subagents`; the Pi tool-name bound follows the shared 80-character limit.

| Command | Exit | Result |
| --- | --- | --- |
| `bun run --cwd apps/server vitest run src/provider/Layers/Pi src/provider/Layers/Copilot src/provider/Layers/Opencode src/provider/Layers/Codex src/codex src/provider/Layers/Kilocode src/provider/Layers/Cursor src/provider/Layers/Devin src/provider/Layers/Claude src/provider/Layers/CliProxy src/provider/providerSubagents.conformance.test.ts src/provider/Layers/ProviderAdapterRegistry.test.ts` | 0 | 367 files passed, 30 skipped; 1588 tests passed, 40 skipped; 3 capability-assertion failures (above), fixed and re-run: 30/30 |
| `bun run --cwd apps/web vitest run src/components/chat/agents/SubagentsCard.agnostic.test.ts` | 0 | 1/1 |
| `bun run --cwd apps/server thread-tools:manifest:check` | 0 | unchanged |
| `bun fmt` / `bun lint` / `bun typecheck` | 0 / 0 / 0 | lint at the 31-warning baseline |

Load average reached 180–200 during the run (other workloads on the machine); no timeouts.
