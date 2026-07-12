import { ApprovalRequestId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { describePendingApproval } from "./pendingApproval";

describe("describePendingApproval", () => {
  it("explains that a learning skill patch requires explicit approval", () => {
    expect(
      describePendingApproval({
        requestId: ApprovalRequestId.makeUnsafe("learning-skill:proposal-1"),
        requestKind: "file-change",
        createdAt: "2026-07-11T00:00:00.000Z",
        detail: "patch",
        sessionApprovalAvailable: false,
      }),
    ).toEqual({
      summary: "Skill improvement suggested",
      description:
        "bigbud has proposed a targeted patch to a provider-owned skill. The skill remains unchanged unless you approve it.",
    });
  });
});
