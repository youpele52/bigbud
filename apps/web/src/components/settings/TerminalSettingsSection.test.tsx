import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useSettings", () => ({
  useSettings: (selector?: (settings: typeof DEFAULT_UNIFIED_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_UNIFIED_SETTINGS) : DEFAULT_UNIFIED_SETTINGS,
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
}));

import { TerminalSettingsSection } from "./TerminalSettingsSection";

describe("terminal settings order", () => {
  it("groups the Terminal page into appearance, shell, scrolling and agent activity", () => {
    const markup = renderToStaticMarkup(<TerminalSettingsSection />);
    const sectionTitles = [...markup.matchAll(/<h2\b[^>]*>(.*?)<\/h2>/g)].map((match) => match[1]);
    const titles = [...markup.matchAll(/<h3\b[^>]*>(.*?)<\/h3>/g)].map((match) => match[1]);

    expect(sectionTitles).toEqual(["Appearance", "Shell", "Scrolling", "Agent activity"]);
    expect(titles).toEqual([
      "Terminal font",
      "Terminal font size",
      "Terminal theme (dark appearance)",
      "Terminal theme (light appearance)",
      "Terminal ligatures",
      "Terminal inline images",
      "Terminal GPU rendering",
      "Default shell profile",
      "Terminal history suggestions",
      "Terminal scroll speed",
      "Terminal fast scroll speed",
      "Full-screen app scroll speed",
      "Detect when terminal agents finish",
      "Terminal agent hooks",
    ]);
    expect(markup).not.toContain("<details");
    expect(markup).not.toMatch(/<div\b[^>]*\bhidden=/);
  });
});
