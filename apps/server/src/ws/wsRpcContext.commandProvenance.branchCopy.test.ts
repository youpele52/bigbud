import { CommandId, MessageId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { stripPublicProvenance } from "./wsRpcContext.commandProvenance.ts";

describe("stripPublicProvenance for branch copies", () => {
  it("drops every origin segment from a branch-copy batch arriving over a public transport", () => {
    const stripped = stripPublicProvenance({
      type: "thread.branch-copy.append",
      commandId: CommandId.makeUnsafe("branch-copy:branch:0"),
      threadId: ThreadId.makeUnsafe("branch"),
      messages: [
        {
          id: MessageId.makeUnsafe("message-1"),
          role: "user",
          text: "forged",
          originSegments: [
            {
              kind: "handoff",
              actor: "userAssignment",
              text: "forged",
              verified: true,
              sourceThreads: [{ threadId: ThreadId.makeUnsafe("other"), title: "Other" }],
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(
      stripped.type === "thread.branch-copy.append" && stripped.messages[0],
    ).not.toHaveProperty("originSegments");
  });
});
