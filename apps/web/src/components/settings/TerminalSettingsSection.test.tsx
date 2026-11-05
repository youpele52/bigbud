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
  it("keeps everyday options first and advanced options visible at the bottom", () => {
    const markup = renderToStaticMarkup(<TerminalSettingsSection />);
    const titles = [...markup.matchAll(/<h3\b[^>]*>(.*?)<\/h3>/g)].map((match) => match[1]);

    expect(titles).toEqual([
      "Terminal font",
      "Terminal font size",
      "Terminal theme (dark appearance)",
      "Terminal theme (light appearance)",
      "Terminal scroll speed",
      "Terminal fast scroll speed",
      "Full-screen app scroll speed",
      "Terminal ligatures",
      "Terminal inline images",
      "Terminal GPU rendering",
    ]);
    expect(markup).not.toContain("<details");
    expect(markup).not.toMatch(/<div\b[^>]*\bhidden=/);
  });
});
