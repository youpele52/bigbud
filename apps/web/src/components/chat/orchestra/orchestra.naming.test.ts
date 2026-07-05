import { describe, expect, it, vi } from "vitest";

import {
  normalizeOrchestraScoreName,
  resolveOrchestraScoreName,
  validateOrchestraScoreName,
} from "./orchestra.naming";

describe("orchestra.naming", () => {
  it("normalizes whitespace in score names", () => {
    expect(normalizeOrchestraScoreName("  Night   Shift  ")).toBe("Night Shift");
  });

  it("allows empty score names so orchestra can auto-name them", () => {
    expect(validateOrchestraScoreName("")).toBeNull();
    expect(validateOrchestraScoreName("   ")).toBeNull();
  });

  it("requires at least three characters for non-empty score names", () => {
    expect(validateOrchestraScoreName(" a ")).toBe("Use at least 3 characters or leave it blank.");
    expect(validateOrchestraScoreName("ab")).toBe("Use at least 3 characters or leave it blank.");
    expect(validateOrchestraScoreName("Trio")).toBeNull();
  });

  it("falls back to a musical codename when no score name is provided", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);

    expect(resolveOrchestraScoreName("   ")).toBe("Adagio");

    randomSpy.mockRestore();
  });
});
