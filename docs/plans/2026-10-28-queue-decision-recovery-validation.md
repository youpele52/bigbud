# Queue decision and recovery validation

Scope: queue changes only. No workspace-wide checks, staging, commits, or pushes.

## Results

| Check                            | Result                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| Explicit-path formatting         | Passed for 41 implementation/plan files                                            |
| Explicit-path lint               | Passed for 39 TypeScript/source/test files, zero warnings/errors                   |
| Source/test length               | All 39 files at most 400 lines                                                     |
| Configured typechecks            | Server, web, contracts, and shared passed                                          |
| Main focused server run          | 159/160 passed; remaining fake-clock fixture corrected and its 14-test file passed |
| Review-fix server run            | Six affected files, 37 tests passed                                                |
| Final ownership suite            | 12 tests passed, including three changed-owner/epoch/reservation cases             |
| Live atomic-settings integration | One test passed                                                                    |
| Web unit tests                   | Four files, 19 tests passed                                                        |
| Browser queue tests              | Seven tests passed                                                                 |

The original test failure was a fixture that created the pending turn before setting its fake
server clock. Flush events now record execution time independently of immutable request timestamps.
The corrected fixture creates the pending start under that fake clock. Earlier implementation
failures (receipt-column constraint, TypeScript narrowing, mock projection, and review-discovered
owned retry/ownership races) were resolved and affected checks rerun.

## Exact focused check scope

The formatter and linter were invoked with the following explicit paths (JSON/package and Markdown
files are excluded from lint and the source/test length check):

```text
apps/server/src/orchestration/Errors.ts
apps/server/src/orchestration/Layers/OrchestrationEngine.commandProcessing.ts
apps/server/src/orchestration/Layers/OrchestrationEngine.invariants.test.ts
apps/server/src/orchestration/Layers/OrchestrationEngine.queueAttempts.test.ts
apps/server/src/orchestration/Layers/OrchestrationEngine.queuedPromptRecovery.test.ts
apps/server/src/orchestration/Layers/OrchestrationEngine.rejectionReceipt.ts
apps/server/src/orchestration/Layers/ProviderCommandReactor.queueRelease.test.ts
apps/server/src/orchestration/Layers/ProviderCommandReactorHandlers.session.ts
apps/server/src/orchestration/Layers/ProviderCommandReactorHandlers.steer.test.ts
apps/server/src/orchestration/Layers/ProviderCommandReactorHandlers.steer.ts
apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.turnControlRecovery.ts
apps/server/src/orchestration/QueuedPromptDecision.logic.ts
apps/server/src/orchestration/QueuedPromptFlush.control.ts
apps/server/src/orchestration/QueuedPromptFlush.logic.ts
apps/server/src/orchestration/QueuedPromptFlush.pendingTurnStart.test.ts
apps/server/src/orchestration/QueuedPromptPolicy.decisions.test.ts
apps/server/src/orchestration/QueuedPromptPolicy.logic.ts
apps/server/src/orchestration/deciderThreads.turn.queue.control.test.ts
apps/server/src/orchestration/deciderThreads.turn.queue.release.test.ts
apps/server/src/orchestration/deciderThreads.turn.queue.release.ts
apps/server/src/orchestration/deciderThreads.turn.queue.test.ts
apps/server/src/orchestration/deciderThreads.turn.queue.ts
apps/server/src/orchestration/deciderThreads.turn.queue.userRelease.test.ts
apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts
apps/server/src/persistence/Migrations.ts
apps/server/src/persistence/Migrations/139_CommandReceiptQueueDecision.test.ts
apps/server/src/persistence/Migrations/139_CommandReceiptQueueDecision.ts
apps/server/src/ws/wsDispatchCommandError.queue.test.ts
apps/server/src/ws/wsDispatchCommandError.ts
apps/web/src/components/chat/view/ChatView.promptQueue.logic.ts
apps/web/src/components/chat/view/ChatView.promptQueue.rejections.browser.tsx
apps/web/src/components/chat/view/ChatView.promptQueue.sendNow.test.ts
apps/web/src/components/chat/view/chat-view/chat-view-prompt-queue.hooks.ts
apps/web/src/lib/orchestrationCommandRecovery.dispatch.ts
apps/web/src/lib/orchestrationCommandRecovery.queue.test.ts
docs/plans/2026-10-28-queue-decision-recovery-plan.md
packages/contracts/src/orchestration/orchestration.commands.client.ts
packages/contracts/src/orchestration/orchestration.queueDecision.ts
packages/contracts/src/orchestration/orchestration.rpc.ts
packages/shared/package.json
packages/shared/src/queueDecision.ts
```

Commands:

```sh
bun run oxfmt --check <explicit paths listed above>
bun run oxlint --report-unused-disable-directives <listed .ts and .tsx paths>
bun run --cwd apps/server typecheck
bun run --cwd apps/web typecheck
bun run --cwd packages/contracts typecheck
bun run --cwd packages/shared typecheck
```

Direct length validation counted lines in each listed `.ts`/`.tsx` file and required `<= 400`.

## Focused tests

Main server command:

```sh
bun run --cwd apps/server vitest run \
  src/orchestration/deciderThreads.turn.queue.test.ts \
  src/orchestration/deciderThreads.turn.queue.control.test.ts \
  src/orchestration/deciderThreads.turn.queue.metadata.test.ts \
  src/orchestration/deciderThreads.turn.queue.userRelease.test.ts \
  src/orchestration/deciderThreads.turn.queue.singlePrompt.test.ts \
  src/orchestration/deciderThreads.turn.queue.alreadySent.test.ts \
  src/orchestration/deciderThreads.turn.queue.release.test.ts \
  src/orchestration/deciderThreads.turn.queue.origins.test.ts \
  src/orchestration/deciderThreads.turn.queue.admission.test.ts \
  src/orchestration/QueuedPromptFlush.pendingTurnStart.test.ts \
  src/orchestration/QueuedPromptFlush.logic.test.ts \
  src/orchestration/QueuedPromptPolicy.decisions.test.ts \
  src/orchestration/QueuedPromptPolicy.redelivery.test.ts \
  src/orchestration/Layers/OrchestrationEngine.invariants.test.ts \
  src/orchestration/Layers/OrchestrationEngine.queueAttempts.test.ts \
  src/orchestration/Layers/OrchestrationEngine.queuedPromptRecovery.test.ts \
  src/orchestration/Layers/OrchestrationEngine.queuedPromptOwnership.test.ts \
  src/orchestration/Layers/OrchestrationEngine.queuedPromptMetadata.test.ts \
  src/orchestration/Layers/OrchestrationEngine.commandOutcome.test.ts \
  src/orchestration/Layers/ProviderCommandReactorHandlers.steer.test.ts \
  src/orchestration/Layers/ProviderCommandReactor.queuedPromptSettlement.test.ts \
  src/orchestration/Layers/ProviderRuntimeIngestion.queuedPromptSettlement.test.ts \
  src/orchestration/Layers/ProviderRuntimeIngestion.turnControlRecovery.test.ts \
  src/persistence/Layers/OrchestrationCommandReceipts.test.ts \
  src/persistence/Migrations/139_CommandReceiptQueueDecision.test.ts \
  src/ws/wsDispatchCommandError.queue.test.ts
```

Corrected fixture and review fixes:

```sh
bun run --cwd apps/server vitest run src/orchestration/QueuedPromptFlush.pendingTurnStart.test.ts
bun run --cwd apps/server vitest run \
  src/orchestration/Layers/OrchestrationEngine.queueAttempts.test.ts \
  src/orchestration/QueuedPromptPolicy.decisions.test.ts \
  src/orchestration/Layers/ProviderCommandReactorHandlers.steer.test.ts \
  src/orchestration/Layers/ProviderRuntimeIngestion.turnControlRecovery.test.ts \
  src/orchestration/Layers/ProviderCommandReactor.queuedPromptSettlement.test.ts \
  src/orchestration/Layers/ProviderCommandReactor.queueRelease.test.ts
bun run --cwd apps/server vitest run src/orchestration/QueuedPromptPolicy.decisions.test.ts
bun run --cwd apps/server vitest run src/orchestration/Layers/ProviderCommandReactor.queueRelease.test.ts
bun run --cwd apps/web vitest run \
  src/components/chat/view/ChatView.promptQueue.logic.test.ts \
  src/components/chat/view/ChatView.promptQueue.sendNow.test.ts \
  src/lib/orchestrationCommandRecovery.test.ts \
  src/lib/orchestrationCommandRecovery.queue.test.ts
bun run --cwd apps/web test:browser src/components/chat/view/ChatView.promptQueue.rejections.browser.tsx
```

## Review

Independent review identified and prompted fixes for owned-attempt revision poisoning and delayed
handlers adopting a newer operation. Final independent re-review marked every requirement complete
and found no remaining substantive issue.
