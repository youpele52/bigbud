/**
 * Decider cases for project-scoped commands.
 *
 * Handles: project.create, project.meta.update, project.delete
 */
import {
  BUILT_IN_CHATS_PROJECT_ID,
  LOCAL_EXECUTION_TARGET_ID,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { resolveProviderSessionExecutionTargets } from "../provider/providerSessionExecutionTargets.ts";
import {
  listThreadsByProjectId,
  requireProjectAbsent,
  requireProjectDeleting,
  requireProjectNotDeleting,
} from "./commandInvariants.ts";
import { nowIso, withEventBase } from "./deciderHelpers.ts";

export const decideProjectCommand = Effect.fn("decideProjectCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: Extract<
    OrchestrationCommand,
    {
      type:
        | "project.create"
        | "project.meta.update"
        | "project.delete"
        | "project.delete.finalize"
        | "project.delete.abort";
    }
  >;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });
      const executionTargets = resolveProviderSessionExecutionTargets({
        providerRuntimeExecutionTargetId: command.providerRuntimeExecutionTargetId,
        workspaceExecutionTargetId: command.workspaceExecutionTargetId,
        executionTargetId: command.executionTargetId,
        defaultProviderRuntimeExecutionTargetId: LOCAL_EXECUTION_TARGET_ID,
        defaultWorkspaceExecutionTargetId: LOCAL_EXECUTION_TARGET_ID,
      });

      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          ...executionTargets,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProjectNotDeleting({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      const executionTargets = resolveProviderSessionExecutionTargets({
        providerRuntimeExecutionTargetId: command.providerRuntimeExecutionTargetId,
        workspaceExecutionTargetId: command.workspaceExecutionTargetId,
        executionTargetId: command.executionTargetId,
      });
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.providerRuntimeExecutionTargetId !== undefined ||
          command.workspaceExecutionTargetId !== undefined ||
          command.executionTargetId !== undefined
            ? executionTargets
            : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      if (command.projectId === BUILT_IN_CHATS_PROJECT_ID) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The built-in Chats project cannot be deleted.",
        });
      }
      yield* requireProjectNotDeleting({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => {
          return thread.deletedAt === null;
        },
      );
      return [
        ...activeThreads
          .filter((thread) => thread.deletingAt === null || thread.deletingAt === undefined)
          .map((thread) =>
            Object.assign(
              withEventBase({
                aggregateKind: "thread",
                aggregateId: thread.id,
                occurredAt,
                commandId: command.commandId,
              }),
              {
                type: "thread.deletion-requested" as const,
                payload: {
                  threadId: thread.id,
                  deletingAt: occurredAt,
                },
              },
            ),
          ),
        {
          ...withEventBase({
            aggregateKind: "project",
            aggregateId: command.projectId,
            occurredAt,
            commandId: command.commandId,
          }),
          type: "project.deletion-requested",
          payload: {
            projectId: command.projectId,
            deletingAt: occurredAt,
          },
        },
      ];
    }

    case "project.delete.finalize": {
      yield* requireProjectDeleting({
        readModel,
        command,
        projectId: command.projectId,
      });
      const remainingThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
      if (remainingThreads.length > 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' cannot be deleted while it still has ${remainingThreads.length} active thread(s).`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.deleted",
        payload: {
          projectId: command.projectId,
          deletedAt: command.createdAt,
        },
      };
    }

    case "project.delete.abort": {
      yield* requireProjectDeleting({
        readModel,
        command,
        projectId: command.projectId,
      });
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.deletion-failed",
        payload: {
          projectId: command.projectId,
          updatedAt: command.createdAt,
        },
      };
    }
  }
});
