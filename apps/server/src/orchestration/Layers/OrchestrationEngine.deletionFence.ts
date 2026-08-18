import type { OrchestrationCommand, OrchestrationReadModel, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { ThreadDeletionShape } from "../../deletion/Services/ThreadDeletion.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";

const commandThreadId = (command: OrchestrationCommand): ThreadId | undefined =>
  command.type === "thread.create"
    ? command.parentThread?.threadId
    : "threadId" in command
      ? command.threadId
      : undefined;

export function makeDeletionFence(input: {
  readonly threadDeletion: ThreadDeletionShape;
  readonly readModel: () => OrchestrationReadModel;
}) {
  const allowsWhileFenced = (command: OrchestrationCommand, threadId: ThreadId) =>
    command.type === "thread.delete.finalize" || command.type === "thread.delete.abort"
      ? input.threadDeletion.isFenceRoot(threadId)
      : Effect.succeed(false);

  const assertAllows = (command: OrchestrationCommand) => {
    const threadId = commandThreadId(command);
    if (
      threadId === undefined ||
      (command.type === "thread.session.set" && command.session.status === "stopped")
    ) {
      return Effect.void;
    }
    return allowsWhileFenced(command, threadId).pipe(
      Effect.flatMap((allowed) =>
        allowed
          ? Effect.void
          : input.threadDeletion.isFenced({ threadId, readModel: input.readModel() }).pipe(
              Effect.flatMap((fenced) =>
                fenced
                  ? Effect.fail(
                      new OrchestrationCommandInvariantError({
                        commandType: command.type,
                        detail: `Thread '${threadId}' or an ancestor is being deleted.`,
                      }),
                    )
                  : Effect.void,
              ),
            ),
      ),
    );
  };

  const acquire = (command: OrchestrationCommand) =>
    command.type === "thread.delete"
      ? input.threadDeletion.acquireFence(command.threadId)
      : Effect.succeed(true);

  const release = (command: OrchestrationCommand) => {
    switch (command.type) {
      case "thread.delete":
      case "thread.delete.finalize":
      case "thread.delete.abort":
        return input.threadDeletion.releaseFence(command.threadId);
      default:
        return Effect.void;
    }
  };

  return { assertAllows, acquire, release } as const;
}
