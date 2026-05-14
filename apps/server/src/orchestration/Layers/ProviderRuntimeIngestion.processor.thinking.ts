import { type CommandId, type ProviderRuntimeEvent, type ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import {
  isThinkingStreamKind,
  thinkingActivityIdFromRuntimeEvent,
  thinkingActivityItemToken,
  thinkingActivityKind,
  thinkingActivitySummary,
  thinkingActivityThreadPrefix,
  thinkingActivityTurnPrefix,
  toThinkingActivityPayload,
} from "../thinkingActivity.ts";
import type {
  RuntimeProcessorCacheHelpers,
  RuntimeProcessorServices,
} from "./ProviderRuntimeIngestion.processor.ts";
import { toTurnId } from "./ProviderRuntimeIngestion.helpers.ts";

export function makeThinkingProcessorHelpers(
  services: Pick<RuntimeProcessorServices, "orchestrationEngine">,
  cacheHelpers: Pick<
    RuntimeProcessorCacheHelpers,
    | "appendBufferedThinking"
    | "takeBufferedThinking"
    | "listBufferedThinkingActivityIdsByThreadPrefix"
    | "listBufferedThinkingActivityIdsByTurnPrefix"
    | "listBufferedThinkingActivityIdsByItemToken"
  >,
  providerCommandId: (event: ProviderRuntimeEvent, tag: string) => CommandId,
) {
  const { orchestrationEngine } = services;

  const appendThinkingDelta = Effect.fn("appendThinkingDelta")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.type !== "content.delta" || !isThinkingStreamKind(event.payload.streamKind)) {
      return;
    }
    if (event.payload.delta.length === 0) return;

    yield* cacheHelpers.appendBufferedThinking({
      activityId: thinkingActivityIdFromRuntimeEvent({
        threadId: event.threadId,
        turnId: event.turnId,
        itemId: event.itemId,
        streamKind: event.payload.streamKind,
      }),
      threadId: event.threadId,
      turnId: toTurnId(event.turnId),
      streamKind: event.payload.streamKind,
      createdAt: event.createdAt,
      delta: event.payload.delta,
    });
  });

  const finalizeThinkingActivity = Effect.fn("finalizeThinkingActivity")(function* (
    event: ProviderRuntimeEvent,
    activityId: string,
  ) {
    const bufferedThinking = yield* cacheHelpers.takeBufferedThinking(activityId);
    if (!bufferedThinking) {
      return;
    }

    const payload = toThinkingActivityPayload(bufferedThinking);
    if (payload.detail.trim().length === 0) {
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: providerCommandId(event, "thinking-activity-append"),
      threadId: bufferedThinking.threadId,
      activity: {
        id: bufferedThinking.activityId,
        tone: "thinking",
        kind: thinkingActivityKind(bufferedThinking.streamKind),
        summary: thinkingActivitySummary(bufferedThinking.streamKind),
        payload,
        turnId: bufferedThinking.turnId ?? null,
        createdAt: bufferedThinking.createdAt,
      },
      createdAt: event.createdAt,
    });
  });

  const finalizeThinkingForThread = Effect.fn("finalizeThinkingForThread")(function* (
    event: ProviderRuntimeEvent,
    threadId: ThreadId,
  ) {
    const activityIds = yield* cacheHelpers.listBufferedThinkingActivityIdsByThreadPrefix(
      thinkingActivityThreadPrefix(threadId),
    );
    yield* Effect.forEach(
      activityIds,
      (activityId) => finalizeThinkingActivity(event, activityId),
      {
        concurrency: 1,
      },
    ).pipe(Effect.asVoid);
  });

  const finalizeThinkingForTurn = Effect.fn("finalizeThinkingForTurn")(function* (
    event: ProviderRuntimeEvent,
    threadId: ThreadId,
    turnId: string,
  ) {
    const activityIds = yield* cacheHelpers.listBufferedThinkingActivityIdsByTurnPrefix(
      thinkingActivityTurnPrefix(threadId, turnId),
    );
    yield* Effect.forEach(
      activityIds,
      (activityId) => finalizeThinkingActivity(event, activityId),
      {
        concurrency: 1,
      },
    ).pipe(Effect.asVoid);
  });

  const finalizeThinkingForItem = Effect.fn("finalizeThinkingForItem")(function* (
    event: ProviderRuntimeEvent,
    itemId: string,
  ) {
    const activityIds = yield* cacheHelpers.listBufferedThinkingActivityIdsByItemToken(
      thinkingActivityItemToken(itemId),
    );
    yield* Effect.forEach(
      activityIds,
      (activityId) => finalizeThinkingActivity(event, activityId),
      {
        concurrency: 1,
      },
    ).pipe(Effect.asVoid);
  });

  return {
    appendThinkingDelta,
    finalizeThinkingForItem,
    finalizeThinkingForTurn,
    finalizeThinkingForThread,
  };
}
