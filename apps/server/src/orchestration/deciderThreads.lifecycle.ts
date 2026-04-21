/**
 * Decider cases for thread lifecycle commands:
 * create, delete, archive, unarchive, meta.update, runtime-mode.set, interaction-mode.set
 */
import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@bigbud/contracts";
import { Effect } from "effect";

import {
  requireProject,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
} from "./commandInvariants.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { nowIso, withEventBase } from "./deciderHelpers.ts";

/** Maximum number of seed messages accepted on `thread.create` to prevent write amplification. */
const MAX_SEED_MESSAGES = 200;

export type ThreadLifecycleCommand = Extract<
  OrchestrationCommand,
  {
    type:
      | "thread.create"
      | "thread.delete"
      | "thread.archive"
      | "thread.unarchive"
      | "thread.meta.update"
      | "thread.runtime-mode.set"
      | "thread.interaction-mode.set";
  }
>;

export const decideThreadLifecycleCommand = Effect.fn("decideThreadLifecycleCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: ThreadLifecycleCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError
> {
  switch (command.type) {
    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.parentThread !== undefined) {
        const parentThread = yield* requireThread({
          readModel,
          command,
          threadId: command.parentThread.threadId,
        });
        if (parentThread.projectId !== command.projectId) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Parent thread '${command.parentThread.threadId}' must belong to project '${command.projectId}'.`,
          });
        }
      }
      const createdEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          ...(command.parentThread !== undefined ? { parentThread: command.parentThread } : {}),
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      if (!command.seedMessages || command.seedMessages.length === 0) {
        return createdEvent;
      }
      if (command.seedMessages.length > MAX_SEED_MESSAGES) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `seedMessages length ${command.seedMessages.length} exceeds the maximum of ${MAX_SEED_MESSAGES}.`,
        });
      }
      return [
        createdEvent,
        ...command.seedMessages.map(
          (message): Omit<OrchestrationEvent, "sequence"> => ({
            ...withEventBase({
              aggregateKind: "thread",
              aggregateId: command.threadId,
              occurredAt: message.updatedAt,
              commandId: command.commandId,
            }),
            type: "thread.message-sent" as const,
            payload: {
              threadId: command.threadId,
              messageId: message.id,
              role: message.role,
              text: message.text,
              ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
              turnId: message.turnId,
              streaming: message.streaming,
              createdAt: message.createdAt,
              updatedAt: message.updatedAt,
            },
          }),
        ),
      ];
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }
  }
});
