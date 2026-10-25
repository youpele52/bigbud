import { describe, expect, it } from "vitest";

import { parseSubagentCap } from "./ProviderCard.claudeSubagentCaps";

describe("parseSubagentCap", () => {
  it("treats an empty field as unset (Claude Code default)", () => {
    expect(parseSubagentCap("")).toBeNull();
    expect(parseSubagentCap("  ")).toBeNull();
  });

  it("accepts whole numbers from 1 to 64", () => {
    expect(parseSubagentCap("1")).toBe(1);
    expect(parseSubagentCap(" 64 ")).toBe(64);
  });

  it("rejects values the Claude Code CLI would refuse", () => {
    for (const raw of ["0", "65", "-1", "1.5", "two", "1e2"]) {
      expect(parseSubagentCap(raw)).toBe("invalid");
    }
  });
});
