# create_thread model choice — validation ledger (2026-10-15)

Plan: `docs/plan/2026-10-15-create-thread-model-choice-plan.md` (Phases 0–4; Phase 5 deferred).
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

| Test | Red (before code) | Green |
|---|---|---|
| `packages/contracts … orchestration.delegationModelChoice.test.ts` | exit 1, module not found | 4/4 |
| `packages/shared … delegatedModelChoice.test.ts` | exit 1, module not found | 5/5 |
| `apps/server … deciderThreads.delegationModelChoice.test.ts` | exit 1, 9 failed (unknown command types) | 9/9 |
| `apps/server … OrchestrationEngine.prepareCommandState.test.ts` (2 new cases) | 2 failed (`operational` loaded) | 7/7 |

Gate commands (all exit 0):

- `bun run --cwd packages/contracts vitest run src/orchestration/orchestration.delegationModelChoice.test.ts` — 4 passed.
- `bun run --cwd packages/shared vitest run src/delegatedModelChoice.test.ts` — 5 passed.
- `bun run --cwd apps/server vitest run src/orchestration/deciderThreads.delegationModelChoice.test.ts src/orchestration/ThreadDispatchSafety.logic.test.ts src/orchestration/ThreadWorkflowStatus.logic.test.ts src/orchestration/Layers/OrchestrationEngine.prepareCommandState.test.ts src/orchestration/deciderThreads.turn.queue.test.ts src/orchestration/deciderThreads.turn.start.dispatchSafety.test.ts src/orchestration/deciderThreads.fork.test.ts src/orchestration/decider.opencodePolicy.test.ts` — 8 files, 93 passed.
- Extra regressions: `commandDigest`, `commandInvariants`, `decider.turn.start`, `Normalizer`, `deciderThreads.turn.queue.{admission,control}` — 6 files, 31 passed; full contracts suite 35 files, 206 passed.
- `bun fmt` 0, `bun fmt:check` 0, `bun lint` 0, `bun typecheck` 0 (9/9 tasks).
- `bun run --cwd apps/server thread-tools:manifest:check` 0; no change under `provider/Layers/OpencodeV2/`.
- Line counts: every new/edited code file ≤ 400 (`orchestration.commands.client.ts` exactly 400).
