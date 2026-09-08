export type ProviderIntentEvent = Extract<
  import("@bigbud/contracts").OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.message-sent"
      | "thread.turn-interrupt-requested"
      | "thread.turn-steer-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested"
      | "thread.deletion-requested"
      | "thread.meta-updated"
      | "project.deletion-requested";
  }
>;

export const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

export const markTurnStartHandled = (cache: Cache.Cache<string, true>, key: string) =>
  Cache.getOption(cache, key).pipe(
    Effect.flatMap((cached) => Cache.set(cache, key, true).pipe(Effect.as(Option.isSome(cached)))),
  );
import { Cache, Effect, Option } from "effect";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";

export const annotateProviderIntentEvent = Effect.fn("annotateProviderIntentEvent")(function* (
  event: ProviderIntentEvent,
) {
  yield* Effect.annotateCurrentSpan({
    "orchestration.event_type": event.type,
    ...("threadId" in event.payload
      ? { "orchestration.thread_id": event.payload.threadId }
      : { "orchestration.project_id": event.payload.projectId }),
    ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
  });
  yield* increment(orchestrationEventsProcessedTotal, { eventType: event.type });
});
