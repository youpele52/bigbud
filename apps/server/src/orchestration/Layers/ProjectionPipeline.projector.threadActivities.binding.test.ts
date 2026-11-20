import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import { makeThreadActivitiesProjector } from "./ProjectionPipeline.projector.threadActivities.ts";

it("persists authoritative acceptance order even when the binding payload has no sequence", async () => {
  const upsert = vi.fn(() => Effect.void);
  const projector = makeThreadActivitiesProjector({
    projectionThreadActivityRepository: { upsert },
    projectionTurnRepository: {},
  } as unknown as Parameters<typeof makeThreadActivitiesProjector>[0]);
  const event = {
    type: "thread.activity-appended",
    sequence: 42,
    payload: {
      threadId: "child",
      activity: {
        id: "binding",
        turnId: "native-not-reserved",
        kind: "text-generation.user-turn-bound",
        tone: "info",
        summary: "Submitted",
        createdAt: "2026-11-11T00:00:00.000Z",
        payload: { messageId: "source-request", sessionEpoch: 7 },
      },
    },
  } as OrchestrationEvent;
  await Effect.runPromise(projector.apply(event, {} as never));
  expect(upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      sequence: 42,
      turnId: "native-not-reserved",
      payload: { messageId: "source-request", sessionEpoch: 7 },
    }),
  );
});
