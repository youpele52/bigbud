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
    command.type === "thread.delete.finalize" ||
    command.type === "thread.delete.abort" ||
    command.type === "thread.retention-delete"
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

  const acquire = (command: OrchestrationCommand) => {
    if (command.type === "thread.delete") {
      return input.threadDeletion.acquireFence(command.threadId);
    }
    if (command.type === "thread.retention-delete") {
      return input.threadDeletion
        .isFenceRoot(command.threadId)
        .pipe(
          Effect.flatMap((held) =>
            held ? Effect.succeed(true) : input.threadDeletion.acquireFence(command.threadId),
          ),
        );
    }
    return Effect.succeed(true);
  };

  const release = (command: OrchestrationCommand) => {
    switch (command.type) {
      case "thread.delete":
      case "thread.retention-delete":
      case "thread.delete.finalize":
      case "thread.delete.abort":
        return input.threadDeletion.releaseFence(command.threadId);
      default:
        return Effect.void;
    }
  };

  const releaseAfterProcess = (command: OrchestrationCommand, accepted: boolean) => {
    if (command.type === "thread.delete.finalize" || command.type === "thread.delete.abort") {
      return accepted ? release(command) : Effect.void;
    }
    if (command.type === "thread.delete") {
      return accepted ? Effect.void : release(command);
    }
    if (command.type === "thread.retention-delete") {
      if (!accepted) return release(command);
      const thread = input
        .readModel()
        .threads.find((candidate) => candidate.id === command.threadId);
      return thread?.deletingAt == null ? release(command) : Effect.void;
    }
    return Effect.void;
  };

  return { assertAllows, acquire, release, releaseAfterProcess } as const;
}
