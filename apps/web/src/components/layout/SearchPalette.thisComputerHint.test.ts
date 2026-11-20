import { describe, expect, it } from "vitest";

import { shouldShowThisComputerHint } from "./SearchPalette.thisComputerHint";

describe("shouldShowThisComputerHint", () => {
  const base = { query: "inv", supported: true, thisComputer: false, hasSeenHint: false };

  it("shows once where an OS index exists for 2+ character queries while the setting is off", () => {
    expect(shouldShowThisComputerHint(base)).toBe(true);
    expect(shouldShowThisComputerHint({ ...base, query: "i" })).toBe(false);
    expect(shouldShowThisComputerHint({ ...base, hasSeenHint: true })).toBe(false);
    expect(shouldShowThisComputerHint({ ...base, thisComputer: true })).toBe(false);
    expect(shouldShowThisComputerHint({ ...base, supported: false })).toBe(false);
  });

  it("still shows when the setting is on (the default) but File Access is No access", () => {
    expect(shouldShowThisComputerHint({ ...base, thisComputer: true, noFileAccess: true })).toBe(
      true,
    );
    expect(shouldShowThisComputerHint({ ...base, thisComputer: true, noFileAccess: false })).toBe(
      false,
    );
  });
});
