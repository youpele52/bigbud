import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationSession,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { requireThread } from "./commandInvariants.ts";
import { withEventBase } from "./deciderHelpers.ts";
import { requireThreadReadyForMutation } from "./deciderThreads.turn.start.ts";

type ThreadSessionCommand = Extract<
  OrchestrationCommand,
  | { type: "thread.turn.interrupt" }
  | { type: "thread.turn.steer" }
  | { type: "thread.approval.respond" }
  | { type: "thread.user-input.respond" }
  | { type: "thread.session.stop" }
  | { type: "thread.session.set" }
  | { type: "thread.turn.start.failed" }
  | { type: "thread.turn-control.set" }
>;

const terminalControlStates = new Set(["completed", "failed", "superseded", "cancelled"]);

/**
 * Session `updatedAt` is operational metadata. Provider lifecycle polling can
 * report the same state repeatedly with a fresh timestamp, but those reports
 * do not represent a new canonical state transition.
 */
function hasSameCanonicalSessionState(
  current: OrchestrationSession,
  next: OrchestrationSession,
): boolean {
  return (
    current.threadId === next.threadId &&
    current.status === next.status &&
    current.providerName === next.providerName &&
    current.runtimeMode === next.runtimeMode &&
    current.activeTurnId === next.activeTurnId &&
    (current.sessionEpoch ?? 0) === (next.sessionEpoch ?? 0) &&
    (current.reason ?? null) === (next.reason ?? null) &&
    current.lastError === next.lastError
  );
}

export const decideThreadSessionCommand = Effect.fn("decideThreadSessionCommand")(
  function* (input: {
    readonly command: ThreadSessionCommand;
    readonly readModel: OrchestrationReadModel;
  }): Effect.fn.Return<
    Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
    OrchestrationCommandInvariantError
  > {
    const { command, readModel } = input;
    const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
    switch (command.type) {
      case "thread.turn.interrupt":
        yield* requireThreadReadyForMutation({ thread, command });
        if (
          command.sessionEpoch !== undefined &&
          command.sessionEpoch !== (thread.session?.sessionEpoch ?? 0)
        ) {
          return [];
        }
        if (
          thread.pendingTurnControlOperation &&
          !terminalControlStates.has(thread.pendingTurnControlOperation.state)
        ) {
          return [];
        }
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
            ...(command.queuedPromptIdsAfterSettlement !== undefined
              ? {
                  operation: {
                    operationId: command.commandId,
                    action: "interrupt-and-continue" as const,
                    reservedPromptIds: command.queuedPromptIdsAfterSettlement,
                    sessionEpoch: thread.session?.sessionEpoch ?? 0,
                    expectedTurnId: command.turnId ?? thread.session?.activeTurnId ?? null,
                    strategy: "interrupt-continue" as const,
                    state: "requested" as const,
                    requestedAt: command.createdAt,
                    updatedAt: command.createdAt,
                  },
                }
              : {}),
            createdAt: command.createdAt,
          },
        };
      case "thread.turn.steer":
        yield* requireThreadReadyForMutation({ thread, command });
        if (
          command.sessionEpoch !== undefined &&
          command.sessionEpoch !== (thread.session?.sessionEpoch ?? 0)
        ) {
          return [];
        }
        if (
          thread.pendingTurnControlOperation &&
          !terminalControlStates.has(thread.pendingTurnControlOperation.state)
        ) {
          return [];
        }
        if (!thread.session?.activeTurnId || thread.session.activeTurnId !== command.turnId) {
          return [];
        }
        const steerPrefix = (thread.queuedPrompts ?? []).slice(0, command.queuedPromptIds.length);
        if (
          steerPrefix.length !== command.queuedPromptIds.length ||
          steerPrefix.some((prompt, index) => prompt.id !== command.queuedPromptIds[index])
        ) {
          return [];
        }
        return {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.turn-steer-requested",
          payload: {
            threadId: command.threadId,
            turnId: command.turnId,
            queuedPromptIds: command.queuedPromptIds,
            operation: {
              operationId: command.commandId,
              action: "steer",
              reservedPromptIds: command.queuedPromptIds,
              sessionEpoch: thread.session?.sessionEpoch ?? 0,
              expectedTurnId: command.turnId ?? null,
              strategy: "pending-selection",
              state: "requested",
              requestedAt: command.createdAt,
              updatedAt: command.createdAt,
            },
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
        if (
          command.sessionEpoch !== undefined &&
          command.sessionEpoch !== (thread.session?.sessionEpoch ?? 0)
        ) {
          return [];
        }
        return {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.session-stop-requested",
          payload: {
            threadId: command.threadId,
            operation: {
              operationId: command.commandId,
              action: "stop",
              reservedPromptIds: [],
              sessionEpoch: thread.session?.sessionEpoch ?? 0,
              expectedTurnId: thread.session?.activeTurnId ?? null,
              strategy: "stop-session",
              state: "requested",
              requestedAt: command.createdAt,
              updatedAt: command.createdAt,
            },
            createdAt: command.createdAt,
          },
        };
      case "thread.session.set":
        if (
          command.expectedActiveTurnId !== undefined &&
          thread.session?.activeTurnId !== command.expectedActiveTurnId
        ) {
          return [];
        }
        if (
          command.expectedSessionEpoch !== undefined &&
          (thread.session?.sessionEpoch ?? 0) !== command.expectedSessionEpoch
        ) {
          return [];
        }
        if (command.session.status !== "stopped" || thread.deletedAt !== null) {
          yield* requireThreadReadyForMutation({ thread, command });
        }
        const nextSession: OrchestrationSession = {
          ...command.session,
          sessionEpoch: command.advanceSessionEpoch
            ? (thread.session?.sessionEpoch ?? 0) + 1
            : (thread.session?.sessionEpoch ?? 0),
        };
        if (thread.session && hasSameCanonicalSessionState(thread.session, nextSession)) {
          return [];
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
          payload: {
            threadId: command.threadId,
            session: nextSession,
          },
        };
      case "thread.turn-control.set":
        if (
          command.expectedOperationId !== undefined &&
          thread.pendingTurnControlOperation?.operationId !== command.expectedOperationId
        ) {
          return [];
        }
        if (
          command.operation.sessionEpoch !== (thread.session?.sessionEpoch ?? 0) &&
          command.operation.state !== "superseded" &&
          command.operation.state !== "completed"
        )
          return [];
        return {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.turn-control-set",
          payload: { threadId: command.threadId, operation: command.operation },
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
