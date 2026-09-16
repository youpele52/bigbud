import { describe, expect, it } from "vitest";

import { shouldFollowMobileThreadContent } from "./mobileThreadFollowing.logic";

describe("shouldFollowMobileThreadContent", () => {
  it("follows content while the reader is near the bottom", () => {
    expect(shouldFollowMobileThreadContent(119)).toBe(true);
    expect(shouldFollowMobileThreadContent(120)).toBe(false);
  });

  it("does not let provider activity override reader position", () => {
    expect(shouldFollowMobileThreadContent(800)).toBe(false);
  });
});
