import { EventId, TurnId, type OrchestrationThreadActivity } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { deriveVisibleWorkLogEntries } from "./session.logic";

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.completed",
    summary: overrides.summary ?? "Activity",
    tone: overrides.tone ?? "tool",
    payload: overrides.payload ?? {},
    turnId: overrides.turnId ? TurnId.makeUnsafe(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

describe("deriveVisibleWorkLogEntries", () => {
  it("keeps prior-turn thinking visible while scoping tool work to the latest turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "thinking-turn-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "thinking.stream",
        summary: "Thinking",
        tone: "thinking",
        payload: { detail: "First turn reasoning" },
        turnId: "turn-1",
      }),
      makeActivity({
        id: "tool-turn-1",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Listed files",
        tone: "tool",
        payload: { toolTitle: "Glob" },
        turnId: "turn-1",
      }),
      makeActivity({
        id: "thinking-turn-2",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "thinking.stream",
        summary: "Thinking",
        tone: "thinking",
        payload: { detail: "Second turn reasoning" },
        turnId: "turn-2",
      }),
      makeActivity({
        id: "tool-turn-2",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.completed",
        summary: "Built table",
        tone: "tool",
        payload: { toolTitle: "Table" },
        turnId: "turn-2",
      }),
    ];

    const entries = deriveVisibleWorkLogEntries(activities, TurnId.makeUnsafe("turn-2"));

    expect(entries.map((entry) => entry.id)).toEqual([
      "thinking-turn-1",
      "thinking-turn-2",
      "tool-turn-2",
    ]);
    expect(entries.map((entry) => entry.tone)).toEqual(["thinking", "thinking", "tool"]);
  });

  it("omits thinking entries entirely when thinking display is disabled", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "thinking-turn-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "thinking.stream",
        summary: "Thinking",
        tone: "thinking",
        payload: { detail: "First turn reasoning" },
        turnId: "turn-1",
      }),
      makeActivity({
        id: "task-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Reasoning update",
        tone: "thinking",
        payload: { detail: "Summarizing the plan" },
        turnId: "turn-2",
      }),
      makeActivity({
        id: "tool-turn-2",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Built table",
        tone: "tool",
        payload: { toolTitle: "Table" },
        turnId: "turn-2",
      }),
    ];

    const entries = deriveVisibleWorkLogEntries(activities, TurnId.makeUnsafe("turn-2"), {
      includeThinking: false,
    });

    expect(entries.map((entry) => entry.id)).toEqual(["tool-turn-2"]);
    expect(entries.map((entry) => entry.tone)).toEqual(["tool"]);
  });
});
