import { describe, expect, it } from "vitest";

import {
  isOngoingAgentWorkSessionReason,
  isStaleRunningSessionUpdate,
} from "./events.store.threads.runtime.logic";

describe("isOngoingAgentWorkSessionReason", () => {
  it("recognizes Pi multi-turn agent loop reasons", () => {
    expect(isOngoingAgentWorkSessionReason("turn.completed.awaiting_agent_end")).toBe(true);
    expect(isOngoingAgentWorkSessionReason("assistant_message.pending_completion")).toBe(true);
    expect(isOngoingAgentWorkSessionReason("turn.queued")).toBe(true);
    expect(isOngoingAgentWorkSessionReason("agent_start")).toBe(true);
  });

  it("does not treat unrelated reasons as ongoing agent work", () => {
    expect(isOngoingAgentWorkSessionReason("context.compacting")).toBe(false);
    expect(isOngoingAgentWorkSessionReason("turn.completed")).toBe(false);
    expect(isOngoingAgentWorkSessionReason(null)).toBe(false);
  });
});

describe("isStaleRunningSessionUpdate", () => {
  const baseInput = {
    incomingStatus: "running" as const,
    incomingActiveTurnId: "turn-1",
    latestTurn: {
      turnId: "turn-1",
      completedAt: null,
    },
    hasNonStreamingAssistantMessageForTurn: true,
  };

  it("keeps Pi awaiting-agent-end updates while assistant output already landed", () => {
    expect(
      isStaleRunningSessionUpdate({
        ...baseInput,
        incomingReason: "turn.completed.awaiting_agent_end",
      }),
    ).toBe(false);
  });

  it("still treats post-completion compaction updates as stale", () => {
    expect(
      isStaleRunningSessionUpdate({
        ...baseInput,
        incomingReason: "context.compacting",
        latestTurn: {
          turnId: "turn-1",
          completedAt: "2026-02-27T00:00:02.000Z",
        },
      }),
    ).toBe(true);
  });
});
