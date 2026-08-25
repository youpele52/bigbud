import {
  CommandId,
  MessageId,
  type OrchestrationReadModel,
  type ProviderSession,
} from "@bigbud/contracts";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { setTurnControlOperation } from "./ProviderCommandReactorHandlers.steer.ts";

const terminalStates = new Set(["completed", "failed", "superseded", "cancelled"]);

/** Recovers incomplete operations without retrying ambiguous provider delivery. */
export function recoverTurnControlOperations(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly readModel: OrchestrationReadModel;
  readonly liveSessions: ReadonlyArray<ProviderSession>;
  readonly occurredAt: string;
}) {
  const liveByThread = new Map(input.liveSessions.map((session) => [session.threadId, session]));
  return Effect.forEach(
    input.readModel.threads,
    (thread) => {
      const operation = thread.pendingTurnControlOperation;
      if (!operation || terminalStates.has(operation.state)) return Effect.void;
      if (operation.sessionEpoch !== (thread.session?.sessionEpoch ?? 0)) {
        return setTurnControlOperation({
          ...input,
          threadId: thread.id,
          operation,
          state: "superseded",
          createdAt: input.occurredAt,
        }).pipe(Effect.asVoid);
      }
      if (operation.state === "requested" && operation.strategy === "native-steer") {
        return setTurnControlOperation({
          ...input,
          threadId: thread.id,
          operation,
          state: "ambiguous",
          error: "bigbud restarted before provider acknowledgement was durably confirmed.",
          deliveryAmbiguous: true,
          createdAt: input.occurredAt,
        }).pipe(Effect.asVoid);
      }
      if (operation.strategy === "native-steer" && operation.state === "provider-acknowledged") {
        return flushReservedPrefix(input, thread.id, operation, true);
      }
      if (operation.strategy !== "interrupt-continue") return Effect.void;
      const live = liveByThread.get(thread.id);
      if (
        live?.sessionEpoch === operation.sessionEpoch &&
        live.activeTurnId === operation.expectedTurnId
      ) {
        return operation.state === "requested"
          ? setTurnControlOperation({
              ...input,
              threadId: thread.id,
              operation,
              state: "failed",
              error: "bigbud restarted before provider interruption was acknowledged.",
              createdAt: input.occurredAt,
            }).pipe(Effect.asVoid)
          : Effect.void;
      }
      if (thread.session?.activeTurnId != null) return Effect.void;
      return operation.reservedPromptIds.length === 0
        ? completeOperation(input, thread.id, operation)
        : flushReservedPrefix(input, thread.id, operation, false);
    },
    { concurrency: 1, discard: true },
  );
}

function flushReservedPrefix(
  input: Pick<
    Parameters<typeof recoverTurnControlOperations>[0],
    "orchestrationEngine" | "occurredAt"
  >,
  threadId: import("@bigbud/contracts").ThreadId,
  operation: import("@bigbud/contracts").OrchestrationTurnControlOperation,
  consumeOnly: boolean,
) {
  return input.orchestrationEngine
    .dispatch({
      type: "thread.queued-prompt.flush",
      commandId: CommandId.makeUnsafe(`server:turn-control:${operation.operationId}:flush`),
      threadId,
      messageIds: operation.reservedPromptIds,
      messageId: MessageId.makeUnsafe(`turn-control:${operation.operationId}`),
      acknowledged: true,
      ...(consumeOnly ? { consumeOnly: true } : {}),
      controlOperationId: operation.operationId,
      createdAt: input.occurredAt,
    })
    .pipe(Effect.andThen(completeOperation(input, threadId, operation)), Effect.asVoid);
}

function completeOperation(
  input: Pick<
    Parameters<typeof recoverTurnControlOperations>[0],
    "orchestrationEngine" | "occurredAt"
  >,
  threadId: import("@bigbud/contracts").ThreadId,
  operation: import("@bigbud/contracts").OrchestrationTurnControlOperation,
) {
  return setTurnControlOperation({
    orchestrationEngine: input.orchestrationEngine,
    threadId,
    operation,
    state: "completed",
    createdAt: input.occurredAt,
  });
}
