import { describe, expect, it } from "vitest";

import { resolveIdleTimeoutDraft } from "./ItutuIdleSettingsSection.logic";

describe("resolveIdleTimeoutDraft", () => {
  it("saves whole minutes within 1 minute to 7 days", () => {
    expect(resolveIdleTimeoutDraft("1", 10)).toBe(1);
    expect(resolveIdleTimeoutDraft(" 45 ", 10)).toBe(45);
    expect(resolveIdleTimeoutDraft("10080", 10)).toBe(10080);
  });

  it("restores the current value for unchanged, invalid, or out-of-range drafts", () => {
    for (const draft of ["10", "", "0", "1.5", "-3", "10081", "ten"]) {
      expect(resolveIdleTimeoutDraft(draft, 10), draft).toBe(null);
    }
  });
});
