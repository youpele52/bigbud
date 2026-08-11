import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { requireThread } from "./commandInvariants.ts";
import { withEventBase } from "./deciderHelpers.ts";
import { requireThreadReadyForMutation } from "./deciderThreads.turn.start.ts";

type ThreadSessionCommand = Extract<
  OrchestrationCommand,
  | { type: "thread.turn.interrupt" }
  | { type: "thread.approval.respond" }
  | { type: "thread.user-input.respond" }
  | { type: "thread.session.stop" }
  | { type: "thread.session.set" }
  | { type: "thread.turn.start.failed" }
>;

export const decideThreadSessionCommand = Effect.fn("decideThreadSessionCommand")(
  function* (input: {
    readonly command: ThreadSessionCommand;
    readonly readModel: OrchestrationReadModel;
  }): Effect.fn.Return<Omit<OrchestrationEvent, "sequence">, OrchestrationCommandInvariantError> {
    const { command, readModel } = input;
    const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
    switch (command.type) {
      case "thread.turn.interrupt":
        yield* requireThreadReadyForMutation({ thread, command });
        if (command.queuedPromptIdsAfterSettlement !== undefined) {
          const prefix = (thread.queuedPrompts ?? []).slice(
            0,
            command.queuedPromptIdsAfterSettlement.length,
          );
          if (
            command.queuedPromptIdsAfterSettlement.length === 0 ||
            prefix.length !== command.queuedPromptIdsAfterSettlement.length ||
            prefix.some(
              (prompt, index) => prompt.id !== command.queuedPromptIdsAfterSettlement![index],
            )
          ) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Queued prompts changed before Send now could be applied.",
            });
          }
        }
        return {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.turn-interrupt-requested",
          payload: {
            threadId: command.threadId,
            ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
            ...(command.queuedPromptIdsAfterSettlement !== undefined
              ? {
                  pendingFlushIntent: {
                    intentId: command.commandId,
                    ...(command.turnId !== undefined ? { requestedTurnId: command.turnId } : {}),
                    queuedPromptIds: command.queuedPromptIdsAfterSettlement,
                    requestedAt: command.createdAt,
                  },
                }
              : {}),
            createdAt: command.createdAt,
          },
        };
      case "thread.approval.respond":
        yield* requireThreadReadyForMutation({ thread, command });
        return {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
            metadata: { requestId: command.requestId },
          }),
          type: "thread.approval-response-requested",
          payload: {
            threadId: command.threadId,
            requestId: command.requestId,
            decision: command.decision,
            createdAt: command.createdAt,
          },
        };
      case "thread.user-input.respond":
        yield* requireThreadReadyForMutation({ thread, command });
        return {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
            metadata: { requestId: command.requestId },
          }),
          type: "thread.user-input-response-requested",
          payload: {
            threadId: command.threadId,
            requestId: command.requestId,
            answers: command.answers,
            createdAt: command.createdAt,
          },
        };
      case "thread.session.stop":
        yield* requireThreadReadyForMutation({ thread, command });
        return {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.session-stop-requested",
          payload: { threadId: command.threadId, createdAt: command.createdAt },
        };
      case "thread.session.set":
        if (command.session.status !== "stopped" || thread.deletedAt !== null) {
          yield* requireThreadReadyForMutation({ thread, command });
        }
        return {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
            metadata: {},
          }),
          type: "thread.session-set",
          payload: { threadId: command.threadId, session: command.session },
        };
      case "thread.turn.start.failed":
        yield* requireThreadReadyForMutation({ thread, command });
        return {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.turn-start-failed",
          payload: {
            threadId: command.threadId,
            context: command.context,
            detail: command.detail,
            createdAt: command.createdAt,
          },
        };
    }
  },
);
