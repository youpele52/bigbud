import type { OrchestrationCommand, OrchestrationReadModel, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import {
  resolveProjectDeletionRequests,
  type ThreadDeletionShape,
} from "../../deletion/Services/ThreadDeletion.ts";
import { retentionDeletionMode } from "../../deletion/Services/ThreadDeletion.mode.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";

const commandThreadId = (command: OrchestrationCommand): ThreadId | undefined =>
  command.type === "thread.create"
    ? command.parentThread?.threadId
    : command.type === "thread.fork"
      ? command.sourceThreadId
      : "threadId" in command
        ? command.threadId
        : undefined;

export function makeDeletionFence(input: {
  readonly threadDeletion: ThreadDeletionShape;
  readonly readModel: () => OrchestrationReadModel;
}) {
  const projectFenceRootsByCommandId = new Map<string, ReadonlyArray<ThreadId>>();
  // Retention commands that took their fence themselves; only those may release it.
  const retentionFenceOwners = new Set<string>();
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
      return input.threadDeletion.acquireFence(command.threadId, "single");
    }
    if (command.type === "thread.retention-delete") {
      // The fence mode must match the mode the decider requests (D-3). A per-thread run reuses
      // any fence it finds instead of upgrading it: the thread is then already being deleted (the
      // run's re-check skips it), and a `subtree` fence would strand that delete's own request.
      const mode = retentionDeletionMode(command.selectionMode);
      return input.threadDeletion
        .isFenceRoot(command.threadId, mode === "single" ? undefined : "subtree")
        .pipe(
          Effect.flatMap((held) =>
            held
              ? Effect.succeed(true)
              : input.threadDeletion.acquireFence(command.threadId, mode).pipe(
                  Effect.tap((acquired) =>
                    Effect.sync(() => {
                      if (acquired) retentionFenceOwners.add(command.commandId);
                    }),
                  ),
                ),
          ),
        );
    }
    if (command.type === "project.delete") {
      const readModel = input.readModel();
      const project = readModel.projects.find((candidate) => candidate.id === command.projectId);
      if (!project || project.deletedAt !== null || project.deletingAt !== null) {
        return Effect.succeed(true);
      }
      const rootThreadIds = resolveProjectDeletionRequests(
        command.projectId,
        readModel.threads,
      ).map((thread) => thread.id);
      return input.threadDeletion.acquireFences(rootThreadIds, "subtree").pipe(
        Effect.tap((acquired) =>
          Effect.sync(() => {
            if (acquired) projectFenceRootsByCommandId.set(command.commandId, rootThreadIds);
          }),
        ),
      );
    }
    return Effect.succeed(true);
  };

  const release = (command: OrchestrationCommand) => {
    switch (command.type) {
      case "thread.delete":
        return input.threadDeletion.releaseFence(command.threadId, "single");
      case "thread.retention-delete":
        return input.threadDeletion.releaseFence(
          command.threadId,
          retentionDeletionMode(command.selectionMode),
        );
      case "thread.delete.finalize":
      case "thread.delete.abort":
        return input.threadDeletion.releaseFence(command.threadId, command.mode);
      default:
        return Effect.void;
    }
  };

  const releaseAfterProcess = (command: OrchestrationCommand, accepted: boolean) => {
    if (command.type === "project.delete") {
      const rootThreadIds = projectFenceRootsByCommandId.get(command.commandId);
      projectFenceRootsByCommandId.delete(command.commandId);
      return !accepted && rootThreadIds !== undefined
        ? Effect.forEach(
            rootThreadIds,
            (rootThreadId) => input.threadDeletion.releaseFence(rootThreadId),
            { discard: true },
          )
        : Effect.void;
    }
    if (command.type === "thread.delete.finalize" || command.type === "thread.delete.abort") {
      return accepted ? release(command) : Effect.void;
    }
    if (command.type === "thread.delete") {
      return accepted ? Effect.void : release(command);
    }
    if (command.type === "thread.retention-delete") {
      // A fence this command found already held belongs to the deletion that holds it.
      if (!retentionFenceOwners.delete(command.commandId)) return Effect.void;
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
