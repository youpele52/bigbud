/**
 * Decider cases for project-scoped commands.
 *
 * Handles: project.create, project.meta.update, project.delete
 */
import {
  BUILT_IN_CHATS_PROJECT_ID,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  listThreadsByProjectId,
  requireProject,
  requireProjectAbsent,
} from "./commandInvariants.ts";
import { nowIso, withEventBase } from "./deciderHelpers.ts";

export const decideProjectCommand = Effect.fn("decideProjectCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: Extract<
    OrchestrationCommand,
    { type: "project.create" | "project.meta.update" | "project.delete" }
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
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
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
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
      return [
        ...activeThreads.map((thread) =>
          Object.assign(
            withEventBase({
              aggregateKind: "thread",
              aggregateId: thread.id,
              occurredAt,
              commandId: command.commandId,
            }),
            {
              type: "thread.deleted" as const,
              payload: {
                threadId: thread.id,
                deletedAt: occurredAt,
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
          type: "project.deleted",
          payload: {
            projectId: command.projectId,
            deletedAt: occurredAt,
          },
        },
      ];
    }
  }
});
