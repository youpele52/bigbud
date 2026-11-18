import { describe, expect, it } from "vitest";

import { ThreadId } from "@bigbud/contracts/core/baseSchemas";

import { initialMobileRecoveryState } from "../logic/mobileRecovery.types";
import { hasOlderMobileHistory, shouldShowMobileEmptyState } from "./MobileThread.view.logic";

const idleInput = {
  hasConnectionNotice: false,
  hasPendingApproval: false,
  hasPendingUserInput: false,
  hasWorkingIndicator: false,
  isRunning: false,
  messages: [{ role: "system" as const }],
  workLogEntryCount: 0,
};

describe("shouldShowMobileEmptyState", () => {
  it("allows an idle draft to show the centered logo", () => {
    expect(shouldShowMobileEmptyState(idleInput)).toBe(true);
  });

  it.each([
    ["conversation messages", { messages: [{ role: "assistant" as const }] }],
    ["work log entries", { workLogEntryCount: 1 }],
    ["working indicator", { hasWorkingIndicator: true }],
    ["running turn", { isRunning: true }],
    ["pending approval", { hasPendingApproval: true }],
    ["pending question", { hasPendingUserInput: true }],
    ["connection notice", { hasConnectionNotice: true }],
  ])("hides the logo when %s is visible", (_name, update) => {
    expect(shouldShowMobileEmptyState({ ...idleInput, ...update })).toBe(false);
  });
});

describe("hasOlderMobileHistory", () => {
  const threadId = ThreadId.makeUnsafe("thread-a");
  const state = {
    ...initialMobileRecoveryState("current"),
    selectedThreadId: threadId,
    selectedThreadHasOlderHistory: true,
  };

  it("shows the note only for the selected thread the baseline flagged", () => {
    expect(hasOlderMobileHistory(state, threadId)).toBe(true);
    expect(hasOlderMobileHistory(state, ThreadId.makeUnsafe("thread-b"))).toBe(false);
    expect(
      hasOlderMobileHistory({ ...state, selectedThreadHasOlderHistory: false }, threadId),
    ).toBe(false);
  });
});
