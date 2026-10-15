import {
  CommandId,
  EventId,
  type MessageId,
  type OrchestrationMessage,
  type ThreadId,
} from "@bigbud/contracts";
import type { TurnStartFailureClass } from "@bigbud/contracts/orchestration/orchestration.turnFailure.ts";
import { Cause, Effect } from "effect";

import type { OrchestrationDispatchError } from "../Errors.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { formatProviderServiceCauseDetail } from "./ProviderCommandReactorHelpers.ts";
import { classifyTurnStartFailure } from "./ProviderTurnFailureClassification.ts";

type TurnStartRequestedEvent = Extract<
  import("@bigbud/contracts").OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

type RecordTurnStartFailure = (input: {
  readonly threadId: ThreadId;
  readonly context: "provider-turn-start";
  readonly detail: string;
  readonly failureClass: TurnStartFailureClass;
  readonly createdAt: string;
  readonly activityId?: EventId;
}) => Effect.Effect<void, OrchestrationDispatchError>;

type RequestAutomaticFork = (input: {
  readonly sourceThreadId: ThreadId;
  readonly failureEventId: EventId;
  readonly pendingMessageId: MessageId;
  readonly createdAt: string;
}) => Effect.Effect<void>;

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
  readonly requestAutomaticFork?: RequestAutomaticFork;
}) {
  return (failure: {
    readonly event: TurnStartRequestedEvent;
    readonly message: OrchestrationMessage;
    readonly cause: Cause.Cause<unknown>;
  }) => {
    const detail = formatProviderServiceCauseDetail(failure.cause);
    const failureClass = classifyTurnStartFailure(failure.cause);
    if (
      failureClass !== "busy" ||
      !canQueueTurnStart({ event: failure.event, message: failure.message })
    ) {
      const threadId = failure.event.payload.threadId;
      const activityId = EventId.makeUnsafe(`turn-start-failed:${failure.event.eventId}`);
      const recorded = input.recordTurnStartFailure({
        threadId,
        context: "provider-turn-start",
        detail,
        failureClass,
        createdAt: failure.event.payload.createdAt,
        activityId,
      });
      // Bounded in-place recovery already ran; still session-dead means it cannot resume (D16).
      const requestAutomaticFork = input.requestAutomaticFork;
      if (failureClass !== "session-dead" || requestAutomaticFork === undefined) return recorded;
      return recorded.pipe(
        Effect.andThen(
          requestAutomaticFork({
            sourceThreadId: threadId,
            failureEventId: activityId,
            pendingMessageId: failure.message.id,
            createdAt: new Date().toISOString(),
          }),
        ),
      );
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
          failureClass,
          createdAt: failure.event.payload.createdAt,
        }),
      ),
      Effect.asVoid,
    );
  };
}
