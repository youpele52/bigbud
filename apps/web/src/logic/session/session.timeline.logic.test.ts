import { MessageId, TurnId, type OrchestrationThreadActivity } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveCompletionDividerBeforeEntryId,
  deriveTimelineEntries,
  deriveVisibleWorkLogEntries,
} from "./session.logic";
import { makeActivity } from "./session.logic.test.helpers";

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

describe("deriveTimelineEntries", () => {
  it("includes proposed plans alongside messages and work entries in chronological order", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "hello",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "# Ship it",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:02.000Z",
        },
      ],
      [
        {
          id: "work-1",
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Ran tests",
          tone: "tool",
        },
      ],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "proposed-plan", "work"]);
    expect(entries[1]).toMatchObject({
      kind: "proposed-plan",
      proposedPlan: {
        planMarkdown: "# Ship it",
        implementedAt: null,
        implementationThreadId: null,
      },
    });
  });

  it("projects thinking entries separately and keeps them before assistant messages", () => {
    const createdAt = "2026-02-23T00:00:01.000Z";
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("user-message"),
          role: "user",
          text: "hello",
          createdAt,
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("assistant-message"),
          role: "assistant",
          text: "hi",
          createdAt,
          streaming: false,
        },
      ],
      [],
      [
        {
          id: "thinking-work",
          createdAt,
          label: "Thinking",
          tone: "thinking",
        },
      ],
    );

    expect(entries.map((entry) => entry.id)).toEqual([
      "user-message",
      "thinking-work",
      "assistant-message",
    ]);
    expect(entries[1]).toMatchObject({
      kind: "thinking",
      entry: {
        id: "thinking-work",
        tone: "thinking",
      },
    });
  });

  it("anchors the completion divider to latestTurn.assistantMessageId before timestamp fallback", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("assistant-earlier"),
          role: "assistant",
          text: "progress update",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("assistant-final"),
          role: "assistant",
          text: "final answer",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [],
      [],
    );

    expect(
      deriveCompletionDividerBeforeEntryId(entries, {
        assistantMessageId: MessageId.makeUnsafe("assistant-final"),
        startedAt: "2026-02-23T00:00:00.000Z",
        completedAt: "2026-02-23T00:00:02.000Z",
      }),
    ).toBe("assistant-final");
  });
});
