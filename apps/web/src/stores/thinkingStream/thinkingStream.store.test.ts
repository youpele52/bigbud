import {
  EventId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ThinkingActivityDeltaEvent,
} from "@bigbud/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { useThinkingStreamStore } from "./thinkingStream.store";

const threadId = ThreadId.makeUnsafe("thread-thinking-stream-test");
const activityId = EventId.makeUnsafe(
  "thinking:thread-thinking-stream-test:turn:turn-1:item:item-1:reasoning_text",
);
const turnId = TurnId.makeUnsafe("turn-1");

function makeDelta(delta: string): ThinkingActivityDeltaEvent {
  return {
    type: "delta",
    threadId,
    activityId,
    turnId,
    provider: "opencode",
    streamKind: "reasoning_text",
    delta,
    createdAt: "2026-05-14T00:00:00.000Z",
  };
}

describe("thinkingStream store", () => {
  beforeEach(() => {
    useThinkingStreamStore.getState().clearAll();
  });

  it("caps transient thinking detail while preserving full character count", () => {
    const firstChunk = "a".repeat(20_000);
    const secondChunk = "b".repeat(10);

    useThinkingStreamStore.getState().applyThinkingDelta(makeDelta(firstChunk));
    useThinkingStreamStore.getState().applyThinkingDelta(makeDelta(secondChunk));

    const activity = useThinkingStreamStore.getState().activitiesByThreadId[threadId]?.[activityId];
    const payload = activity?.payload as Record<string, unknown> | undefined;

    expect(payload?.fullCharCount).toBe(20_010);
    expect(payload?.truncated).toBe(true);
    expect(payload?.detail).toBeTypeOf("string");
    const detail = payload?.detail;
    expect(typeof detail === "string" ? detail.length : 0).toBeLessThan(20_010);
    expect(detail).toContain("[... truncated ...]");
    expect(detail).toMatch(/b{10}$/);
  });

  it("clears thinking state for a deleted thread subtree", () => {
    const descendantThreadId = ThreadId.makeUnsafe("thread-thinking-descendant");
    const retainedThreadId = ThreadId.makeUnsafe("thread-thinking-retained");
    useThinkingStreamStore.getState().applyThinkingDelta(makeDelta("root"));
    useThinkingStreamStore.getState().applyThinkingDelta({
      ...makeDelta("descendant"),
      threadId: descendantThreadId,
    });
    useThinkingStreamStore.getState().applyThinkingDelta({
      ...makeDelta("retained"),
      threadId: retainedThreadId,
    });

    useThinkingStreamStore.getState().reconcilePersistedActivities([
      {
        type: "thread.deleted",
        eventId: EventId.makeUnsafe("event-thread-deleted"),
        sequence: 1,
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-05-14T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          threadIds: [threadId, descendantThreadId],
          deletedAt: "2026-05-14T00:00:00.000Z",
        },
      } satisfies OrchestrationEvent,
    ]);

    expect(useThinkingStreamStore.getState().activitiesByThreadId).toEqual({
      [retainedThreadId]: expect.any(Object),
    });
  });
});
