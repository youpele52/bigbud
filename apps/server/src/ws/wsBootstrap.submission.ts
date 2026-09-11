import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import { OrchestrationDispatchCommandError } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { canAutoDispatchQueuedPrompts } from "../orchestration/QueuedPromptPolicy.logic.ts";

export function validateBootstrapSubmission(input: {
  readonly command: Extract<OrchestrationCommand, { type: "thread.message.submit" }>;
  readonly engine: Pick<OrchestrationEngineShape, "ensureThreadState" | "getReadModel">;
}) {
  return Effect.gen(function* () {
    const { command, engine } = input;
    const thread = engine.ensureThreadState
      ? yield* engine.ensureThreadState(command.threadId, "operational")
      : (yield* engine.getReadModel()).threads.find((entry) => entry.id === command.threadId);
    if (!thread && command.bootstrap?.createThread) return;
    if (!thread) {
      return yield* new OrchestrationDispatchCommandError({
        message: "Bootstrap submission target thread does not exist.",
      });
    }
    if (
      thread.archivedAt != null ||
      thread.deletingAt != null ||
      thread.deletedAt != null ||
      !canAutoDispatchQueuedPrompts(thread) ||
      (thread.queuedPrompts?.length ?? 0) > 0
    ) {
      return yield* new OrchestrationDispatchCommandError({
        message: "Bootstrap preparation requires an idle thread without queued or reserved work.",
      });
    }
  });
}
