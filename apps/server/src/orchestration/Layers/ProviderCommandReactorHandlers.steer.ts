import { MessageId, type OrchestrationTurnControlOperation } from "@bigbud/contracts";
import { Effect, Exit } from "effect";

import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import {
  formatProviderServiceCauseDetail,
  serverCommandId,
} from "./ProviderCommandReactorHelpers.ts";

const followUpText = (texts: ReadonlyArray<string>) =>
  ["Additional instructions:", ...texts.map((text) => `- ${text}`)].join("\n");

export function setTurnControlOperation(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly operation: OrchestrationTurnControlOperation;
  readonly threadId: import("@bigbud/contracts").ThreadId;
  readonly state: OrchestrationTurnControlOperation["state"];
  readonly strategy?: OrchestrationTurnControlOperation["strategy"];
  readonly error?: string;
  readonly deliveryAmbiguous?: boolean;
  readonly createdAt: string;
}) {
  return input.orchestrationEngine.dispatch({
    type: "thread.turn-control.set",
    commandId: serverCommandId(`turn-control-${input.state}`),
    threadId: input.threadId,
    expectedOperationId: input.operation.operationId,
    operation: {
      ...input.operation,
      state: input.state,
      strategy: input.strategy ?? input.operation.strategy,
      updatedAt: input.createdAt,
      ...(input.state === "provider-acknowledged" ? { acknowledgedAt: input.createdAt } : {}),
      ...(["completed", "failed", "superseded", "cancelled"].includes(input.state)
        ? { settledAt: input.createdAt }
        : {}),
      ...(input.error ? { error: input.error } : {}),
      ...(input.deliveryAmbiguous ? { deliveryAmbiguous: true } : {}),
    },
    createdAt: input.createdAt,
  });
}

export function makeProcessTurnSteerRequested(input: {
  readonly providerService: ProviderServiceShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly resolveThread: OrchestrationEngineShape["getReadModel"];
  readonly appendProviderFailureActivity: (input: {
    readonly threadId: import("@bigbud/contracts").ThreadId;
    readonly kind: "provider.turn.steer.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: import("@bigbud/contracts").TurnId | null;
    readonly createdAt: string;
  }) => Effect.Effect<void, OrchestrationDispatchError>;
}) {
  return Effect.fn("processTurnSteerRequested")(function* (
    event: Extract<
      import("@bigbud/contracts").OrchestrationEvent,
      { type: "thread.turn-steer-requested" }
    >,
  ) {
    const operation = event.payload.operation;
    if (!operation) return;
    const thread = (yield* input.resolveThread()).threads.find(
      (candidate) => candidate.id === event.payload.threadId,
    );
    const prefix = (thread?.queuedPrompts ?? []).slice(0, operation.reservedPromptIds.length);
    if (
      !thread ||
      thread.pendingTurnControlOperation?.operationId !== operation.operationId ||
      (thread.session?.sessionEpoch ?? 0) !== operation.sessionEpoch ||
      thread.session?.activeTurnId !== operation.expectedTurnId ||
      prefix.some((prompt, index) => prompt.id !== operation.reservedPromptIds[index])
    ) {
      return;
    }
    const provider = thread.modelSelection.provider;
    const capabilities = yield* input.providerService.getCapabilities(provider);
    const steerTurn = input.providerService.steerTurn;
    const native = capabilities.turnControl?.nativeSteer === true && steerTurn !== undefined;
    const strategy = native ? "native-steer" : "interrupt-continue";
    yield* setTurnControlOperation({
      ...input,
      threadId: thread.id,
      operation,
      state: "requested",
      strategy,
      createdAt: event.payload.createdAt,
    });

    const delivery = native
      ? steerTurn!({
          threadId: thread.id,
          input: followUpText(prefix.map((prompt) => prompt.text)),
          ...(operation.expectedTurnId !== null ? { turnId: operation.expectedTurnId } : {}),
          sessionEpoch: operation.sessionEpoch,
        })
      : input.providerService.interruptTurn({
          threadId: thread.id,
          ...(operation.expectedTurnId !== null ? { turnId: operation.expectedTurnId } : {}),
          sessionEpoch: operation.sessionEpoch,
        });
    const delivered = yield* Effect.exit(delivery);
    if (Exit.isFailure(delivered)) {
      const detail = formatProviderServiceCauseDetail(delivered.cause);
      yield* input.appendProviderFailureActivity({
        threadId: thread.id,
        kind: "provider.turn.steer.failed",
        summary: native
          ? "Provider turn steer delivery is uncertain"
          : "Provider turn interrupt failed",
        detail,
        turnId: operation.expectedTurnId,
        createdAt: event.payload.createdAt,
      });
      yield* setTurnControlOperation({
        ...input,
        threadId: thread.id,
        operation: { ...operation, strategy },
        state: native ? "ambiguous" : "failed",
        error: detail,
        deliveryAmbiguous: native,
        createdAt: event.payload.createdAt,
      });
      return;
    }
    yield* setTurnControlOperation({
      ...input,
      threadId: thread.id,
      operation: { ...operation, strategy },
      state: native ? "provider-acknowledged" : "waiting-for-settlement",
      createdAt: event.payload.createdAt,
    });
    if (!native) return;
    yield* input.orchestrationEngine.dispatch({
      type: "thread.queued-prompt.flush",
      commandId: serverCommandId(`steer-flush-${event.eventId}`),
      threadId: thread.id,
      messageIds: operation.reservedPromptIds,
      messageId: MessageId.makeUnsafe(`steer-message-${event.eventId}`),
      acknowledged: true,
      consumeOnly: true,
      controlOperationId: operation.operationId,
      createdAt: event.payload.createdAt,
    });
    yield* setTurnControlOperation({
      ...input,
      threadId: thread.id,
      operation: { ...operation, strategy },
      state: "completed",
      createdAt: event.payload.createdAt,
    });
  });
}
