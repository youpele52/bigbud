/**
 * OpencodeAdapter stream primitives — shared factory functions for event IDs,
 * stamps, emit, and synthetic events.
 *
 * @module OpencodeAdapter.stream.primitives
 */
import { type Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import { Effect, Queue, Random } from "effect";

import { EventId, TurnId, type ProviderRuntimeEvent } from "@bigbud/contracts";

import { eventBase } from "./Adapter.stream.utils.ts";
import type { EventNdjsonLogger } from "../EventNdjsonLogger.ts";

// ── Stream shared primitives ──────────────────────────────────────────

/** Function type for creating synthetic provider runtime events. */
export type SyntheticEventFn = <TType extends ProviderRuntimeEvent["type"]>(
  threadId: import("@bigbud/contracts").ThreadId,
  type: TType,
  payload: Extract<ProviderRuntimeEvent, { type: TType }>["payload"],
  extra?: { turnId?: TurnId; itemId?: string; requestId?: string },
) => Effect.Effect<Extract<ProviderRuntimeEvent, { type: TType }>>;

export function makeNextEventId(): Effect.Effect<EventId> {
  return Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
}

export function makeEventStampFactory(nextEventId: Effect.Effect<EventId>) {
  return () =>
    Effect.all({
      eventId: nextEventId,
      createdAt: Effect.sync(() => new Date().toISOString()),
    });
}

export function makeEmit(runtimeEventQueue: Queue.Queue<ProviderRuntimeEvent>) {
  return (events: ReadonlyArray<ProviderRuntimeEvent>) =>
    Queue.offerAll(runtimeEventQueue, events).pipe(Effect.asVoid);
}

export const logNativeEvent = Effect.fn("logNativeEvent")(function* (
  nativeEventLogger: EventNdjsonLogger | undefined,
  threadId: import("@bigbud/contracts").ThreadId,
  event: OpencodeEvent,
) {
  if (!nativeEventLogger) {
    return;
  }
  yield* nativeEventLogger.write(
    {
      observedAt: new Date().toISOString(),
      event,
    },
    threadId,
  );
});

export function makeSyntheticEventFn(
  nextEventId: Effect.Effect<EventId>,
  makeEventStamp: () => Effect.Effect<{ eventId: EventId; createdAt: string }>,
) {
  const fn = <TType extends ProviderRuntimeEvent["type"]>(
    threadId: import("@bigbud/contracts").ThreadId,
    type: TType,
    payload: Extract<ProviderRuntimeEvent, { type: TType }>["payload"],
    extra?: { turnId?: TurnId; itemId?: string; requestId?: string },
  ): Effect.Effect<Extract<ProviderRuntimeEvent, { type: TType }>> =>
    Effect.gen(function* () {
      const stamp = yield* makeEventStamp();
      return {
        ...eventBase({
          eventId: stamp.eventId,
          createdAt: stamp.createdAt,
          threadId,
          ...(extra?.turnId ? { turnId: extra.turnId } : {}),
          ...(extra?.itemId ? { itemId: extra.itemId } : {}),
          ...(extra?.requestId ? { requestId: extra.requestId } : {}),
          raw: {
            source: "opencode.sdk.synthetic",
            payload,
          },
        }),
        type,
        payload,
      } as Extract<ProviderRuntimeEvent, { type: TType }>;
    });
  return fn as SyntheticEventFn;
}
