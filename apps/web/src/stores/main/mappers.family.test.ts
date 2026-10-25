import { expect, it } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { mapSession } from "./mappers.store";
import { hasOwnedV2DescendantWork } from "../../components/chat/view/ChatView.subagents.logic";

it("hydration maps canonical retained-family control independently of child cards and root status", () => {
  for (const retainedFamily of [true, false]) {
    const session = mapSession({
      threadId: ThreadId.makeUnsafe("retained-family"),
      providerName: "opencodeV2",
      status: "ready",
      runtimeMode: "full-access",
      activeTurnId: null,
      sessionEpoch: 1,
      lastError: null,
      reason: null,
      updatedAt: "2026-10-21T00:00:00Z",
      retainedFamily,
    });
    expect(session.status).toBe("ready");
    expect(session.activeTurnId).toBeUndefined();
    expect(hasOwnedV2DescendantWork({ session, providerAgents: [] })).toBe(retainedFamily);
  }
});
