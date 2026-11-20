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
      section: "Browser",
      to: "/settings/general",
    });
  });

  it("returns every match before the search field applies its display limit", () => {
    expect(getSettingsSearchResults("ai").length).toBeGreaterThan(6);
  });

  it("finds every terminal control on the Terminal page", () => {
    expect(getSettingsSearchResults("terminal")).toEqual(
      [
        "Terminal",
        "Terminal font",
        "Terminal font size",
        "Default shell profile",
        "Terminal history suggestions",
        "Terminal theme",
        "Terminal scroll speed",
        "Terminal fast scroll speed",
        "Full-screen app scroll speed",
        "Largest pasted file",
        "Clipboard requests from terminal programs",
        "Terminal ligatures",
        "Terminal inline images",
        "Terminal GPU rendering",
        "Detect when terminal agents finish",
        "Terminal agent hooks",
      ].map((label) => ({ label, section: "Terminal", to: "/settings/terminal" })),
    );
    expect(getSettingsSearchResults("terminal gpu")).toEqual([
      { label: "Terminal GPU rendering", section: "Terminal", to: "/settings/terminal" },
    ]);
  });
});
