import { describe, expect, it } from "vitest";
import { MessageId, TurnId } from "@bigbud/contracts";
import {
  computeMessageDurationStart,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
} from "./MessagesTimeline.logic";

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("uses the previous assistant completedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:30Z"],
      ]),
    );
  });

  it("does not advance the boundary for a streaming message without completedAt", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:30Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("resets the boundary on a new user message", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      { id: "u2", role: "user", createdAt: "2026-01-01T00:01:00Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        completedAt: "2026-01-01T00:01:20Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["u2", "2026-01-01T00:01:00Z"],
        ["a2", "2026-01-01T00:01:00Z"],
      ]),
    );
  });

  it("handles system messages without affecting the boundary", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "s1", role: "system", createdAt: "2026-01-01T00:00:01Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["s1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("returns empty map for empty input", () => {
    expect(computeMessageDurationStart([])).toEqual(new Map());
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording from command labels", () => {
    expect(normalizeCompactToolLabel("Ran command complete")).toBe("Ran command");
  });

  it("removes trailing completion wording from other labels", () => {
    expect(normalizeCompactToolLabel("Read file completed")).toBe("Read file");
  });
});

describe("deriveMessagesTimelineRows", () => {
  it("renders thinking timeline entries as dedicated chat-style rows", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "thinking-entry-1",
          kind: "thinking",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "thinking-work-1",
            createdAt: "2026-01-01T00:00:01Z",
            label: "Thinking",
            detail: "Checking the repository layout",
            tone: "thinking",
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
    });

    expect(rows).toEqual([
      {
        kind: "thinking",
        id: "thinking-entry-1",
        createdAt: "2026-01-01T00:00:01Z",
        entry: {
          id: "thinking-work-1",
          createdAt: "2026-01-01T00:00:01Z",
          label: "Thinking",
          detail: "Checking the repository layout",
          tone: "thinking",
        },
        streaming: true,
      },
      {
        kind: "working",
        id: "working-indicator-row",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  it("only shows assistant copy on the final assistant message in a turn", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-entry-1",
          kind: "message",
          createdAt: "2026-01-01T00:00:01Z",
          message: {
            id: MessageId.makeUnsafe("assistant-1"),
            role: "assistant",
            text: "First chunk",
            turnId,
            createdAt: "2026-01-01T00:00:01Z",
            streaming: false,
          },
        },
        {
          id: "assistant-entry-2",
          kind: "message",
          createdAt: "2026-01-01T00:00:02Z",
          message: {
            id: MessageId.makeUnsafe("assistant-2"),
            role: "assistant",
            text: "Final chunk",
            turnId,
            createdAt: "2026-01-01T00:00:02Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> => row.kind === "message",
    );

    expect(assistantRows).toHaveLength(2);
    expect(assistantRows[0]?.showAssistantCopyButton).toBe(false);
    expect(assistantRows[1]?.showAssistantCopyButton).toBe(true);
  });

  it("shows assistant copy for standalone assistant messages without a turn id", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-entry-standalone",
          kind: "message",
          createdAt: "2026-01-01T00:00:01Z",
          message: {
            id: MessageId.makeUnsafe("assistant-standalone"),
            role: "assistant",
            text: "Standalone answer",
            turnId: null,
            createdAt: "2026-01-01T00:00:01Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
    });

    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> => row.kind === "message",
    );

    expect(assistantRow?.showAssistantCopyButton).toBe(true);
  });
});
