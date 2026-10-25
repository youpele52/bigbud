import { EventId, TurnId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { deriveWorkLogEntries } from "./workLog";

describe("work log and prompt suggestions", () => {
  it("never shows a prompt suggestion as a work log row", () => {
    const entries = deriveWorkLogEntries(
      [
        {
          id: EventId.makeUnsafe("suggestion"),
          tone: "info",
          kind: "prompt.suggestion",
          summary: "Suggested next prompt",
          payload: { suggestion: "Add tests for the parser", source: "native", provider: "codex" },
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-10-16T10:00:00.000Z",
        },
      ],
      undefined,
    );
    expect(entries).toEqual([]);
  });
});
