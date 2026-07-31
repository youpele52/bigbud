import { type MessageId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { deriveUserTurnAnchorsFromThreadMessages } from "./chatScroll.timelineRows";

describe("deriveUserTurnAnchorsFromThreadMessages", () => {
  it("keeps user message ids and normalizes their 100-character previews", () => {
    const longText = `${"a".repeat(100)} extra`;

    expect(
      deriveUserTurnAnchorsFromThreadMessages([
        { id: "assistant" as MessageId, role: "assistant", text: "Skipped" },
        { id: "empty" as MessageId, role: "user", text: " \n " },
        { id: "short" as MessageId, role: "user", text: "  Review\n  this  " },
        { id: "long" as MessageId, role: "user", text: longText },
      ]),
    ).toEqual([
      { messageId: "short", label: "Review this" },
      { messageId: "long", label: `${"a".repeat(97)}...` },
    ]);
  });

  it("does not truncate a preview that is exactly 100 characters", () => {
    const text = "a".repeat(100);

    expect(
      deriveUserTurnAnchorsFromThreadMessages([{ id: "user" as MessageId, role: "user", text }]),
    ).toEqual([{ messageId: "user", label: text }]);
  });
});
