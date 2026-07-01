import { type MessageId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveChatReaderPosition,
  deriveCurrentAnchorMessageId,
  deriveVisibleMessageIds,
  readerPositionEquals,
} from "./chatScroll.readerPosition.logic";

describe("chatScroll reader position logic", () => {
  const anchorRows = [
    { messageId: "u1" as MessageId, start: 0, end: 80 },
    { messageId: "u2" as MessageId, start: 400, end: 480 },
    { messageId: "u3" as MessageId, start: 900, end: 980 },
  ];

  const messageRows = [
    { messageId: "u1" as MessageId, start: 0, end: 80 },
    { messageId: "a1" as MessageId, start: 80, end: 360 },
    { messageId: "u2" as MessageId, start: 400, end: 480 },
    { messageId: "a2" as MessageId, start: 480, end: 860 },
    { messageId: "u3" as MessageId, start: 900, end: 980 },
  ];

  it("tracks the last anchored turn at or above the reading line", () => {
    expect(deriveCurrentAnchorMessageId(anchorRows, 0)).toBe("u1");
    expect(deriveCurrentAnchorMessageId(anchorRows, 420)).toBe("u2");
    expect(deriveCurrentAnchorMessageId(anchorRows, 950)).toBe("u3");
  });

  it("reports visible message ids in document order", () => {
    expect(deriveVisibleMessageIds(messageRows, 300, 220)).toEqual(["a1", "u2", "a2"]);
  });

  it("derives a combined reader position snapshot", () => {
    expect(
      deriveChatReaderPosition({
        anchorRows,
        messageRows,
        scrollTop: 420,
        viewportHeight: 220,
      }),
    ).toEqual({
      currentAnchorMessageId: "u2",
      visibleMessageIds: ["u2" as MessageId, "a2" as MessageId],
    });
  });

  it("compares reader positions by value", () => {
    expect(
      readerPositionEquals(
        {
          currentAnchorMessageId: "u2" as MessageId,
          visibleMessageIds: ["a1" as MessageId, "u2" as MessageId],
        },
        {
          currentAnchorMessageId: "u2" as MessageId,
          visibleMessageIds: ["a1" as MessageId, "u2" as MessageId],
        },
      ),
    ).toBe(true);
    expect(
      readerPositionEquals(
        {
          currentAnchorMessageId: "u2" as MessageId,
          visibleMessageIds: ["a1" as MessageId, "u2" as MessageId],
        },
        {
          currentAnchorMessageId: "u3" as MessageId,
          visibleMessageIds: ["a1" as MessageId, "u2" as MessageId],
        },
      ),
    ).toBe(false);
  });
});
