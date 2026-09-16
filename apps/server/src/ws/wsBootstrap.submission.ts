import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import { OrchestrationDispatchCommandError } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { canAutoDispatchQueuedPrompts } from "../orchestration/QueuedPromptPolicy.logic.ts";

type BootstrapPromptCommand = Extract<
  OrchestrationCommand,
  { type: "thread.turn.start" | "thread.message.submit" }
>;

export function validateBootstrapSubmission(input: {
  readonly command: BootstrapPromptCommand;
  readonly engine: Pick<OrchestrationEngineShape, "ensureThreadState" | "getReadModel">;
}) {
  return Effect.gen(function* () {
    const { command, engine } = input;
    const thread = engine.ensureThreadState
      ? yield* engine.ensureThreadState(command.threadId, "operational")
      : yield* command.bootstrap?.createThread
          ? engine.getReadModel().pipe(
              Effect.map((readModel) =>
                readModel.threads.find((entry) => entry.id === command.threadId),
              ),
              // Lightweight bootstrap test doubles may not expose a read model
              // before materialization. The production engine has the hydrator
              // above, so a missing fallback read is treated as a new target.
              Effect.catchCause(() => Effect.void),
            )
          : engine
              .getReadModel()
              .pipe(
                Effect.map((readModel) =>
                  readModel.threads.find((entry) => entry.id === command.threadId),
                ),
              );
    // A createThread payload is the materialization path for a new thread. If
    // it has no existing target, retain its direct create/worktree/setup order.
    if (!thread && command.bootstrap?.createThread) return;
    if (!thread) {
      return yield* new OrchestrationDispatchCommandError({
        message: "Bootstrap submission target thread does not exist.",
      });
    }
    const completeThread = {
      ...thread,
      activities: thread.activities ?? [],
      messages: thread.messages ?? [],
      proposedPlans: thread.proposedPlans ?? [],
    };
    if (
      completeThread.archivedAt != null ||
      completeThread.deletingAt != null ||
      completeThread.deletedAt != null ||
      !canAutoDispatchQueuedPrompts(completeThread) ||
      (completeThread.queuedPrompts?.length ?? 0) > 0
    ) {
      return yield* new OrchestrationDispatchCommandError({
        message:
          "Bootstrap resources cannot be deferred while a thread is busy or has queued work.",
        code: "prompt_not_queueable",
      });
    }
  });
}
