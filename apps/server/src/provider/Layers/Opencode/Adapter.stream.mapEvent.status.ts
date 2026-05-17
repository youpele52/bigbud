import { randomUUID } from "node:crypto";
import { EventId, TurnId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect } from "effect";

import type { ActiveOpencodeSession } from "./Adapter.types.ts";
import { eventBase } from "./Adapter.stream.utils.ts";

type RawOpencodeEvent = {
  readonly source: "opencode.sdk.session-event";
  readonly method: string;
  readonly payload: unknown;
};

function statusMessageLooksLikeCompaction(message: string | undefined): boolean {
  return typeof message === "string" && /compact/i.test(message);
}

export function handleSessionIdle(
  session: ActiveOpencodeSession,
  turnId: TurnId | undefined,
  stamp: { eventId: EventId; createdAt: string },
  raw: RawOpencodeEvent,
  nextEventId: Effect.Effect<EventId>,
): Effect.Effect<ReadonlyArray<ProviderRuntimeEvent>> {
  return Effect.gen(function* () {
    const completedTurnId = turnId;
    session.activeTurnId = undefined;
    session.wasRetrying = false;
    session.turns.at(-1)?.items.push(raw);

    const readyEventId = yield* nextEventId;
    return [
      {
        ...eventBase({
          eventId: stamp.eventId,
          createdAt: stamp.createdAt,
          threadId: session.threadId,
          ...(completedTurnId ? { turnId: completedTurnId } : {}),
          raw,
        }),
        type: "turn.completed",
        payload: {
          state: "completed",
          ...(session.lastUsage ? { usage: session.lastUsage } : {}),
        },
      },
      {
        ...eventBase({
          eventId: readyEventId,
          createdAt: stamp.createdAt,
          threadId: session.threadId,
          raw,
        }),
        type: "session.state.changed",
        payload: { state: "ready", reason: "session.idle" },
      },
    ];
  });
}

export function handleSessionStatus(
  session: ActiveOpencodeSession,
  status: { type: string; message?: string },
  turnId: TurnId | undefined,
  stamp: { eventId: EventId; createdAt: string },
  raw: RawOpencodeEvent,
  nextEventId: Effect.Effect<EventId>,
): Effect.Effect<ReadonlyArray<ProviderRuntimeEvent>> {
  return Effect.gen(function* () {
    if (status.type === "busy") {
      const existingTurnId = session.activeTurnId;
      if (existingTurnId) {
        if (statusMessageLooksLikeCompaction(status.message)) {
          session.wasRetrying = false;
          const compactionEventId = yield* nextEventId;
          return [
            {
              ...eventBase({
                eventId: compactionEventId,
                createdAt: stamp.createdAt,
                threadId: session.threadId,
                turnId: existingTurnId,
                raw,
              }),
              type: "session.state.changed",
              payload: { state: "waiting", reason: "context.compacting", detail: status },
            },
          ];
        }

        if (session.wasRetrying) {
          session.wasRetrying = false;
          const resumeEventId = yield* nextEventId;
          return [
            {
              ...eventBase({
                eventId: resumeEventId,
                createdAt: stamp.createdAt,
                threadId: session.threadId,
                turnId: existingTurnId,
                raw,
              }),
              type: "session.state.changed",
              payload: { state: "running", reason: "session.retry.resumed" },
            },
          ];
        }
        session.turns.at(-1)?.items.push(raw.payload);
        return [];
      }

      const newTurnId = TurnId.makeUnsafe(`opencode-turn-${randomUUID()}`);
      session.activeTurnId = newTurnId;
      session.turns.push({ id: newTurnId, items: [raw.payload] });

      return [
        {
          ...eventBase({
            eventId: stamp.eventId,
            createdAt: stamp.createdAt,
            threadId: session.threadId,
            turnId: newTurnId,
            raw,
          }),
          type: "turn.started",
          payload: session.model ? { model: session.model } : {},
        },
      ];
    }

    if (status.type === "idle") {
      return yield* handleSessionIdle(session, turnId, stamp, raw, nextEventId);
    }

    if (status.type === "retry") {
      session.wasRetrying = true;
      const retryStatus = status as { type: "retry"; message?: string; next?: number };
      const reason = retryStatus.message
        ? `Retrying: ${retryStatus.message}`
        : "session.retry.waiting";
      return [
        {
          ...eventBase({
            eventId: stamp.eventId,
            createdAt: stamp.createdAt,
            threadId: session.threadId,
            ...(turnId ? { turnId } : {}),
            raw,
          }),
          type: "session.state.changed",
          payload: { state: "waiting", reason },
        },
      ];
    }

    return [];
  });
}
