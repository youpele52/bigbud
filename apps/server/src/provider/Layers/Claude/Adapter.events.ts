import {
  ApprovalRequestId,
  EventId,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@bigbud/contracts";
import { DateTime, Deferred, Effect, Queue, Random, Stream } from "effect";

import type { ClaudeSessionContext, UnstampedProviderRuntimeEvent } from "./Adapter.types.ts";
import { claudeInteractionPublication } from "./Adapter.interactionIdentity.ts";
import { makeProviderAdapterEventQueue } from "../../providerEventQueueBounds.ts";

export function deleteClaudeSessionIfCurrent(
  sessions: Map<ThreadId, ClaudeSessionContext>,
  context: ClaudeSessionContext,
): boolean {
  if (sessions.get(context.session.threadId) !== context) return false;
  return sessions.delete(context.session.threadId);
}

export type OfferClaudeRuntimeEvent = (
  context: ClaudeSessionContext,
  event: UnstampedProviderRuntimeEvent,
) => Effect.Effect<void, never, never>;

export const makeClaudeEventRuntime = Effect.fn("ClaudeAdapter.makeEventRuntime")(function* (
  sessions: Map<ThreadId, ClaudeSessionContext>,
) {
  const queue = yield* makeProviderAdapterEventQueue<{
    readonly event: ProviderRuntimeEvent;
    readonly settlement?: NonNullable<ReturnType<typeof claudeInteractionPublication>>;
  }>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
  const makeEventStamp = (): Effect.Effect<{ eventId: EventId; createdAt: string }> =>
    Effect.all({ eventId: nextEventId, createdAt: nowIso });
  const offerRuntimeEvent: OfferClaudeRuntimeEvent = (context, event) =>
    Effect.suspend(() => {
      if (sessions.get(event.threadId) !== context) return Effect.void;
      const requestId = event.requestId;
      const publication =
        requestId && (event.type === "request.resolved" || event.type === "user-input.resolved")
          ? claudeInteractionPublication(context, ApprovalRequestId.makeUnsafe(requestId))
          : undefined;
      return Queue.offer(queue, {
        event: {
          ...event,
          sessionEpoch: context.sessionEpoch,
          ...(publication ? { requestGeneration: publication.generation } : {}),
        },
        ...(publication ? { settlement: publication } : {}),
      }).pipe(Effect.asVoid);
    });

  return {
    makeEventStamp,
    nowIso,
    offerRuntimeEvent,
    shutdown: Queue.shutdown(queue),
    // Accept the event into the queue immediately, but release it downstream only after the
    // callback has finalized its decision and removed the live guard. The take frees capacity
    // before waiting, so the publishing callback can finish even when the queue was full.
    stream: Stream.fromQueue(queue).pipe(
      Stream.mapEffect(({ event, settlement }): Effect.Effect<ProviderRuntimeEvent> => {
        if (!settlement) return Effect.succeed(event);
        return Deferred.await(settlement.completion).pipe(
          Effect.map(() => {
            if (!settlement.isStillBlocking()) return event;
            // A callback defect must not stall the stream or certify a still-live guard.
            const { requestGeneration: _, ...unconfirmed } = event;
            return unconfirmed;
          }),
        );
      }),
    ),
  };
});
