import { CommandId, type OrchestrationMessage, type ThreadId } from "@bigbud/contracts";
import { Cause, Effect, Schema } from "effect";

import { ProviderAdapterValidationError, ProviderValidationError } from "../../provider/Errors.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { formatProviderServiceCauseDetail } from "./ProviderCommandReactorHelpers.ts";

type TurnStartRequestedEvent = Extract<
  import("@bigbud/contracts").OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

type RecordTurnStartFailure = (input: {
  readonly threadId: ThreadId;
  readonly context: "provider-turn-start";
  readonly detail: string;
  readonly createdAt: string;
}) => Effect.Effect<void, OrchestrationDispatchError>;

const PROVIDER_BUSY_TURN_DETAIL =
  /already active|ongoing provider work|cannot start another turn|unresolved turn/i;

export function isProviderTurnBusyCause(cause: Cause.Cause<unknown>): boolean {
  const error = Cause.squash(cause);
  if (
    Schema.is(ProviderAdapterValidationError)(error) ||
    Schema.is(ProviderValidationError)(error)
  ) {
    return PROVIDER_BUSY_TURN_DETAIL.test(error.issue);
  }
  return PROVIDER_BUSY_TURN_DETAIL.test(formatProviderServiceCauseDetail(cause));
}

function canQueueTurnStart(input: {
  readonly event: TurnStartRequestedEvent;
  readonly message: OrchestrationMessage;
}): boolean {
  return input.message.text.trim().length > 0 || (input.message.attachments?.length ?? 0) > 0;
}

function queueTurnStart(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly event: TurnStartRequestedEvent;
  readonly message: OrchestrationMessage;
}) {
  const { event, message, orchestrationEngine } = input;
  return orchestrationEngine.dispatch({
    type: "thread.message.submit",
    commandId: CommandId.makeUnsafe(`server:provider-turn-start-queued:${event.eventId}`),
    threadId: event.payload.threadId,
    message: {
      messageId: message.id,
      text: message.text.trim(),
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      ...(message.replyTo?.messageId !== undefined
        ? { replyToMessageId: message.replyTo.messageId }
        : event.payload.replyTo?.messageId !== undefined
          ? { replyToMessageId: event.payload.replyTo.messageId }
          : {}),
    },
    ...(event.payload.modelSelection !== undefined
      ? { modelSelection: event.payload.modelSelection }
      : {}),
    ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
    runtimeMode: event.payload.runtimeMode,
    interactionMode: event.payload.interactionMode,
    ...(event.payload.bootstrapSourceThreadId !== undefined
      ? { bootstrapSourceThreadId: event.payload.bootstrapSourceThreadId }
      : {}),
    ...(event.payload.sourceProposedPlan !== undefined
      ? { sourceProposedPlan: event.payload.sourceProposedPlan }
      : {}),
    delivery: "queue",
    createdAt: event.payload.createdAt,
  });
}

export function makeHandleTurnStartFailure(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly recordTurnStartFailure: RecordTurnStartFailure;
}) {
  return (failure: {
    readonly event: TurnStartRequestedEvent;
    readonly message: OrchestrationMessage;
    readonly cause: Cause.Cause<unknown>;
  }) => {
    const detail = formatProviderServiceCauseDetail(failure.cause);
    if (
      !isProviderTurnBusyCause(failure.cause) ||
      !canQueueTurnStart({ event: failure.event, message: failure.message })
    ) {
      return input.recordTurnStartFailure({
        threadId: failure.event.payload.threadId,
        context: "provider-turn-start",
        detail,
        createdAt: failure.event.payload.createdAt,
      });
    }

    return queueTurnStart({
      orchestrationEngine: input.orchestrationEngine,
      event: failure.event,
      message: failure.message,
    }).pipe(
      Effect.tap(() =>
        Effect.logWarning("provider turn was busy; queued the follow-up prompt", {
          threadId: failure.event.payload.threadId,
          messageId: failure.message.id,
          eventId: failure.event.eventId,
          detail,
        }),
      ),
      Effect.catchCause((queueCause) =>
        input.recordTurnStartFailure({
          threadId: failure.event.payload.threadId,
          context: "provider-turn-start",
          detail: `${detail} Failed to queue the follow-up prompt: ${formatProviderServiceCauseDetail(queueCause)}`,
          createdAt: failure.event.payload.createdAt,
        }),
      ),
      Effect.asVoid,
    );
  };
}
