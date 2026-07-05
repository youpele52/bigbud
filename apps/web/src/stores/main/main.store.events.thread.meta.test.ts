import { ThreadId, TurnId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { applyOrchestrationEvent } from "./events.store";
import { type AppState } from "./main.store";
import { makeEvent, makeState, makeThread } from "./main.store.test.helpers";

describe("incremental orchestration updates", () => {
  it("does not mark bootstrap complete for incremental events", () => {
    const state: AppState = {
      ...makeState(makeThread()),
      bootstrapComplete: false,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.meta-updated", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "Updated title",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.bootstrapComplete).toBe(false);
  });

  it("settles the latest turn from an interrupt-requested event", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-interrupt-requested", {
        threadId: thread.id,
        turnId: TurnId.makeUnsafe("turn-1"),
        createdAt: "2026-02-27T00:00:03.000Z",
      }),
    );

    expect(next.threads[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-1"),
      state: "interrupted",
      completedAt: "2026-02-27T00:00:03.000Z",
    });
  });

  it("keeps the default elevator summary synced to title changes before first generation", () => {
    const state = makeState(
      makeThread({
        title: "Original title",
        elevatorSummary: "Original title",
        elevatorSummaryMessageCount: 0,
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.meta-updated", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "Renamed title",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.threads[0]?.title).toBe("Renamed title");
    expect(next.threads[0]?.elevatorSummary).toBe("Renamed title");
    expect(next.threads[0]?.elevatorSummaryMessageCount).toBe(0);
  });

  it("preserves a generated elevator summary across later title changes", () => {
    const state = makeState(
      makeThread({
        title: "Original title",
        elevatorSummary: "Short generated summary",
        elevatorSummaryMessageCount: 5,
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.meta-updated", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "Renamed title",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.threads[0]?.title).toBe("Renamed title");
    expect(next.threads[0]?.elevatorSummary).toBe("Short generated summary");
    expect(next.threads[0]?.elevatorSummaryMessageCount).toBe(5);
  });
});
