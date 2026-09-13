import { describe, expect, it } from "vitest";

import { memoryReviewNotification } from "./memoryReview";

describe("memory review notifications", () => {
  it.each([
    ["updated", "success"],
    ["retrying", "info"],
    ["rejected", "warning"],
    ["failed", "error"],
  ])("expresses %s severity", (outcome, severity) => {
    expect(memoryReviewNotification(`learning.memory.${outcome}`)?.type).toBe(severity);
  });

  it("keeps unchanged reviews and unrelated activities out of toasts", () => {
    expect(memoryReviewNotification("learning.memory.unchanged")).toBeNull();
    expect(memoryReviewNotification("approval.requested")).toBeNull();
  });
});
