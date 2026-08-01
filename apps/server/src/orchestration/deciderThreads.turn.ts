/**
 * Decider cases for thread turn, session, message, and activity commands.
 */
import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { requireThread } from "./commandInvariants.ts";
import { withEventBase } from "./deciderHelpers.ts";
import {
  decideThreadActivityAppendCommand,
  decideThreadTurnStartCommand,
  requireThreadReadyForMutation,
} from "./deciderThreads.turn.start.ts";
import { decideThreadQueueCommand } from "./deciderThreads.turn.queue.ts";
import { decideThreadSessionCommand } from "./deciderThreads.turn.session.ts";

export type ThreadTurnCommand = Exclude<
  OrchestrationCommand,
  {
    type:
      | "project.create"
      | "project.meta.update"
      | "project.delete"
      | "project.delete.finalize"
      | "project.delete.abort"
      | "thread.create"
      | "thread.delete"
      | "thread.delete.finalize"
      | "thread.delete.abort"
      | "thread.archive"
      | "thread.unarchive"
      | "thread.pin"
      | "thread.unpin"
      | "thread.pin.migrate"
      | "thread.meta.update"
      | "thread.runtime-mode.set"
      | "thread.interaction-mode.set"
      | "thread.task.upsert"
      | "thread.task.remove";
  }
>;

function buildAssistantMessageEvent(input: {
  readonly command: Extract<
    ThreadTurnCommand,
    | { type: "thread.message.assistant.delta" }
    | { type: "thread.message.assistant.replace" }
    | { type: "thread.message.assistant.complete" }
  >;
  readonly text: string;
  readonly replace: boolean;
  readonly streaming: boolean;
}): Omit<OrchestrationEvent, "sequence"> {
  return {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: input.command.threadId,
      occurredAt: input.command.createdAt,
      commandId: input.command.commandId,
    }),
    type: "thread.message-sent",
    payload: {
      threadId: input.command.threadId,
      messageId: input.command.messageId,
      role: "assistant",
      text: input.text,
      turnId: input.command.turnId ?? null,
      replace: input.replace,
      streaming: input.streaming,
      createdAt: input.command.createdAt,
      updatedAt: input.command.createdAt,
    },
  };
}

export const decideThreadTurnCommand = Effect.fn("decideThreadTurnCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: ThreadTurnCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError
> {
  switch (command.type) {
    case "thread.message.submit":
    case "thread.queued-prompt.remove":
    case "thread.queued-prompt.flush":
      return yield* decideThreadQueueCommand({ command, readModel });

    case "thread.turn.start": {
      return yield* decideThreadTurnStartCommand({ command, readModel });
    }

    case "thread.shell.run": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* requireThreadReadyForMutation({ thread, command });
      const shellRunRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.shell-run-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          shellCommand: command.shellCommand,
          createdAt: command.createdAt,
        },
      };
      return shellRunRequestedEvent;
    }

    case "thread.turn.interrupt":
    case "thread.approval.respond":
    case "thread.user-input.respond":
    case "thread.session.stop":
    case "thread.session.set":
    case "thread.turn.start.failed":
      return yield* decideThreadSessionCommand({ command, readModel });

    case "thread.checkpoint.revert": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* requireThreadReadyForMutation({ thread, command });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.path-checkpoint.capture":
    case "thread.path-checkpoint.restore": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      yield* requireThreadReadyForMutation({ thread, command });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type:
          command.type === "thread.path-checkpoint.capture"
            ? "thread.path-checkpoint-capture-requested"
            : "thread.path-checkpoint-restore-requested",
        payload: { threadId: command.threadId, path: command.path, createdAt: command.createdAt },
      };
    }

    case "thread.message.assistant.delta": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* requireThreadReadyForMutation({ thread, command });
      return buildAssistantMessageEvent({
        command,
        text: command.delta,
        replace: false,
        streaming: true,
      });
    }

    case "thread.message.assistant.replace": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* requireThreadReadyForMutation({ thread, command });
      return buildAssistantMessageEvent({
        command,
        text: command.text,
        replace: true,
        streaming: true,
      });
    }

    case "thread.message.assistant.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* requireThreadReadyForMutation({ thread, command });
      return buildAssistantMessageEvent({
        command,
        text: "",
        replace: false,
        streaming: false,
      });
    }

    case "thread.proposed-plan.upsert": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* requireThreadReadyForMutation({ thread, command });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      return yield* decideThreadActivityAppendCommand({ command, readModel });
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
