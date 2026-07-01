import { type OrchestrationThreadActivity } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { derivePendingApprovals } from "./session.logic";
import { makeActivity } from "./session.logic.test.helpers";

describe("derivePendingApprovals browser approvals", () => {
  it("maps browser approval request types into pending approvals", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-browser",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Browser approval requested",
        tone: "approval",
        payload: {
          requestId: "req-browser-1",
          requestType: "browser_approval",
          detail: "Allow browser navigation",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-browser-1",
        requestKind: "browser",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "Allow browser navigation",
      },
    ]);
  });
});
