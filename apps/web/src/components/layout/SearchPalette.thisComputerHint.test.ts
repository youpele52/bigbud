import { describe, expect, it } from "vitest";

import { shouldShowThisComputerHint } from "./SearchPalette.thisComputerHint";

describe("shouldShowThisComputerHint", () => {
  const base = { query: "inv", mac: true, thisComputer: false, hasSeenHint: false };

  it("shows once on macOS for 2+ character queries while the setting is off", () => {
    expect(shouldShowThisComputerHint(base)).toBe(true);
    expect(shouldShowThisComputerHint({ ...base, query: "i" })).toBe(false);
    expect(shouldShowThisComputerHint({ ...base, hasSeenHint: true })).toBe(false);
    expect(shouldShowThisComputerHint({ ...base, thisComputer: true })).toBe(false);
    expect(shouldShowThisComputerHint({ ...base, mac: false })).toBe(false);
  });
});
