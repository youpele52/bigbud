import { describe, expect, it } from "vitest";

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
});
