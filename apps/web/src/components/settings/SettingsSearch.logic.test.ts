import { describe, expect, it } from "vitest";

import {
  getSettingsSearchResults,
  matchesSettingsSearchTerms,
  normalizeSettingsSearchQuery,
} from "./SettingsSearch.logic";

describe("Settings search", () => {
  it("normalizes surrounding whitespace and casing", () => {
    expect(normalizeSettingsSearchQuery("  Terminal Font  ")).toBe("terminal font");
  });

  it("matches every query token across the available terms", () => {
    expect(matchesSettingsSearchTerms("terminal size", ["Terminal font size", "General"])).toBe(
      true,
    );
    expect(matchesSettingsSearchTerms("terminal browser", ["Terminal font size", "General"])).toBe(
      false,
    );
  });

  it("finds settings through their page and alias labels", () => {
    expect(getSettingsSearchResults("general")).not.toHaveLength(0);
    expect(getSettingsSearchResults("system default browser")).toContainEqual({
      label: "System default browser",
      section: "AI",
      to: "/settings/ai",
    });
  });

  it("returns every match before the search field applies its display limit", () => {
    expect(getSettingsSearchResults("ai").length).toBeGreaterThan(6);
  });
});
