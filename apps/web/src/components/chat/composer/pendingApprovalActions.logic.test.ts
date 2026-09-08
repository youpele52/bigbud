import { ApprovalRequestId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { getPendingApprovalActions } from "./pendingApprovalActions.logic";

describe("getPendingApprovalActions", () => {
  it("matches the normal approval actions", () => {
    expect(
      getPendingApprovalActions({ requestId: ApprovalRequestId.makeUnsafe("request-1") }),
    ).toEqual([
      { decision: "decline", label: "Decline", variant: "ghost" },
      { decision: "cancel", label: "Cancel turn", variant: "ghost" },
      {
        decision: "acceptForSession",
        label: "Always allow this session",
        variant: "outline",
      },
      { decision: "accept", label: "Approve once", variant: "default" },
    ]);
  });

  it("uses the provider session label when session approval is available", () => {
    expect(
      getPendingApprovalActions({
        requestId: ApprovalRequestId.makeUnsafe("request-1"),
        sessionApprovalLabel: "Allow all commands",
      }),
    ).toContainEqual({
      decision: "acceptForSession",
      label: "Allow all commands",
      variant: "outline",
    });
  });

  it("hides unavailable session approval", () => {
    expect(
      getPendingApprovalActions({
        requestId: ApprovalRequestId.makeUnsafe("request-1"),
        sessionApprovalAvailable: false,
      }),
    ).toEqual([
      { decision: "decline", label: "Decline", variant: "ghost" },
      { decision: "cancel", label: "Cancel turn", variant: "ghost" },
      { decision: "accept", label: "Approve once", variant: "default" },
    ]);
  });

  it("matches the skill-patch approval actions", () => {
    expect(
      getPendingApprovalActions({
        requestId: ApprovalRequestId.makeUnsafe("learning-skill:proposal-1"),
      }),
    ).toEqual([
      { decision: "decline", label: "Reject patch", variant: "ghost" },
      {
        decision: "acceptForSession",
        label: "Always allow this session",
        variant: "outline",
      },
      { decision: "accept", label: "Approve patch", variant: "default" },
    ]);
  });
});
