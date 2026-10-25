import { TurnId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { deriveWorkLogEntries } from "./session.logic";
import { makeActivity } from "./session.logic.test.helpers";

describe("provider conversation reset in the work log", () => {
  it("shows the cleared-conversation activity as a normal info entry", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "reset-1",
          turnId: "turn-1",
          kind: "provider-conversation.reset",
          summary: "Provider conversation cleared",
          tone: "info",
        }),
      ],
      TurnId.makeUnsafe("turn-1"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Provider conversation cleared");
  });
});
