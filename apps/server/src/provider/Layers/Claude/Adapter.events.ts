import { EventId, type ProviderRuntimeEvent, type ThreadId } from "@bigbud/contracts";
import { DateTime, Effect, Queue, Random, Stream } from "effect";

import type { ClaudeSessionContext, UnstampedProviderRuntimeEvent } from "./Adapter.types.ts";

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
  const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
  const makeEventStamp = (): Effect.Effect<{ eventId: EventId; createdAt: string }> =>
    Effect.all({ eventId: nextEventId, createdAt: nowIso });
  const offerRuntimeEvent: OfferClaudeRuntimeEvent = (context, event) =>
    sessions.get(event.threadId) === context
      ? Queue.offer(queue, { ...event, sessionEpoch: context.sessionEpoch }).pipe(Effect.asVoid)
      : Effect.void;

  return {
    makeEventStamp,
    nowIso,
    offerRuntimeEvent,
    shutdown: Queue.shutdown(queue),
    stream: Stream.fromQueue(queue),
  };
});
