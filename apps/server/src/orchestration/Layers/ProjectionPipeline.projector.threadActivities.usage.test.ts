import { describe, expect, it } from "vitest";
import { EventId, ThreadId, TurnId } from "@bigbud/contracts";

import { usageContributionFromActivity } from "./ProjectionPipeline.projector.threadActivities.usage.ts";

describe("usageContributionFromActivity", () => {
  it("extracts canonical accounting contributions from context window activities", () => {
    const contribution = usageContributionFromActivity({
      threadId: ThreadId.makeUnsafe("thread-1"),
      activity: {
        id: EventId.makeUnsafe("activity-1"),
        createdAt: "2026-03-02T00:00:00.000Z",
        tone: "info",
        kind: "context-window.updated",
        summary: "Context window updated",
        turnId: TurnId.makeUnsafe("turn-1"),
        sequence: 42,
        payload: {
          usedTokens: 9000,
          accounting: {
            provider: "codex",
            model: "gpt-5.6",
            interactionMode: "default",
            scope: "turn",
            scopeId: "turn-1",
            processedTokens: 1234,
            inputTokens: 1000,
            cachedInputTokens: 100,
            outputTokens: 134,
            reasoningOutputTokens: 0,
            finalized: true,
          },
        },
      },
    });

    expect(contribution).toMatchObject({
      contributionId: "codex:thread-1:turn:turn-1",
      activityId: "activity-1",
      threadId: "thread-1",
      turnId: "turn-1",
      provider: "codex",
      model: "gpt-5.6",
      interactionMode: "default",
      usedTokens: 1234,
      inputTokens: 1000,
      cachedInputTokens: 100,
      outputTokens: 134,
      reasoningOutputTokens: 0,
      finalized: true,
      sourceSequence: 42,
    });
  });

  it("skips context-window-only payloads without accounting", () => {
    const contribution = usageContributionFromActivity({
      threadId: ThreadId.makeUnsafe("thread-1"),
      activity: {
        id: EventId.makeUnsafe("activity-1"),
        createdAt: "2026-03-02T00:00:00.000Z",
        tone: "info",
        kind: "context-window.updated",
        summary: "Context window updated",
        turnId: null,
        payload: { usedTokens: 9000 },
      },
    });

    expect(contribution).toBeUndefined();
  });
});
