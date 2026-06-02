import { describe, expect, it } from "vitest";
import { type TurnId } from "@bigbud/contracts";

import {
  getMessagesTimelineRowMeasurementKey,
  resolveFirstUnvirtualizedRowIndex,
} from "./MessagesTimeline.virtualization";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";

function messageId(
  value: string,
): Extract<MessagesTimelineRow, { kind: "message" }>["message"]["id"] {
  return value as Extract<MessagesTimelineRow, { kind: "message" }>["message"]["id"];
}

function userMessageRow(text: string): Extract<MessagesTimelineRow, { kind: "message" }> {
  return {
    kind: "message",
    id: "row-user",
    createdAt: "2026-03-17T19:12:28.000Z",
    durationStart: "2026-03-17T19:12:28.000Z",
    showCompletionDivider: false,
    showAssistantCopyButton: false,
    message: {
      id: messageId("message-user"),
      role: "user",
      text,
      createdAt: "2026-03-17T19:12:28.000Z",
      streaming: false,
    },
  };
}

function assistantMessageRow(input: {
  id: string;
  createdAt: string;
  text: string;
  streaming?: boolean;
  turnId?: string;
}): Extract<MessagesTimelineRow, { kind: "message" }> {
  return {
    ...userMessageRow(input.text),
    id: input.id,
    createdAt: input.createdAt,
    message: {
      id: messageId(`${input.id}-message`),
      role: "assistant",
      text: input.text,
      createdAt: input.createdAt,
      streaming: input.streaming ?? false,
      ...(input.turnId ? { turnId: input.turnId as TurnId } : {}),
    },
  };
}

function turnRows(turnNumber: number): MessagesTimelineRow[] {
  const baseSeconds = turnNumber * 2;
  const createdAtUser = new Date(
    Date.UTC(2026, 2, 17, 19, 12, 28) + baseSeconds * 1_000,
  ).toISOString();
  const createdAtAssistant = new Date(
    Date.UTC(2026, 2, 17, 19, 12, 28) + (baseSeconds + 1) * 1_000,
  ).toISOString();

  return [
    {
      ...userMessageRow(`turn ${turnNumber}`),
      id: `row-user-${turnNumber}`,
      createdAt: createdAtUser,
      message: {
        ...userMessageRow(`turn ${turnNumber}`).message,
        id: messageId(`message-user-${turnNumber}`),
        createdAt: createdAtUser,
      },
    },
    assistantMessageRow({
      id: `row-assistant-${turnNumber}`,
      createdAt: createdAtAssistant,
      text: `assistant ${turnNumber}`,
    }),
  ];
}

function workRow(id: string, createdAt: string): Extract<MessagesTimelineRow, { kind: "work" }> {
  return {
    kind: "work",
    id,
    createdAt,
    groupedEntries: [],
  };
}

describe("MessagesTimeline virtualization", () => {
  it("keeps the previous user row unvirtualized for active assistant turns", () => {
    const rows: MessagesTimelineRow[] = [
      userMessageRow("short"),
      {
        ...userMessageRow("assistant"),
        id: "row-assistant",
        message: {
          id: messageId("message-assistant"),
          role: "assistant",
          text: "working",
          createdAt: "2026-03-17T19:12:29.000Z",
          streaming: true,
        },
      },
    ];

    expect(
      resolveFirstUnvirtualizedRowIndex({
        activeTurnInProgress: true,
        activeTurnStartedAt: null,
        rows,
      }),
    ).toBe(0);
  });

  it("invalidates cached user row measurements when rendered content length changes", () => {
    const shortKey = getMessagesTimelineRowMeasurementKey(userMessageRow("short"));
    const longKey = getMessagesTimelineRowMeasurementKey(userMessageRow("long\n".repeat(200)));

    expect(longKey).not.toBe(shortKey);
  });

  it("keeps the previous two completed turns mounted when there is older history", () => {
    const rows: MessagesTimelineRow[] = [
      ...Array.from({ length: 5 }, (_, index) => turnRows(index + 1)).flat(),
      ...turnRows(6),
      workRow("work-turn-6-a", "2026-03-17T19:12:41.000Z"),
      workRow("work-turn-6-b", "2026-03-17T19:12:42.000Z"),
      ...turnRows(7),
      workRow("work-turn-7-a", "2026-03-17T19:12:45.000Z"),
      workRow("work-turn-7-b", "2026-03-17T19:12:46.000Z"),
    ];

    expect(
      resolveFirstUnvirtualizedRowIndex({
        activeTurnInProgress: false,
        activeTurnStartedAt: null,
        rows,
      }),
    ).toBe(10);
  });

  it("keeps expanded work rows inside the mounted region", () => {
    const rows: MessagesTimelineRow[] = [
      ...turnRows(1),
      ...turnRows(2),
      {
        ...turnRows(3)[0]!,
      },
      {
        kind: "work",
        id: "work-expanded",
        createdAt: "2026-03-17T19:12:31.000Z",
        groupedEntries: [],
      },
      ...turnRows(3).slice(1),
      ...turnRows(4),
      ...turnRows(5),
      ...turnRows(6),
    ];

    expect(
      resolveFirstUnvirtualizedRowIndex({
        activeTurnInProgress: false,
        activeTurnStartedAt: null,
        rows,
        expandedWorkGroups: { "work-expanded": true },
      }),
    ).toBe(4);
  });
});
