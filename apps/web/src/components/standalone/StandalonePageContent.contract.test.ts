import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CONTENT_PANEL_HEADER_CENTER_GRID_CLASS } from "../layout/ContentPanelHeaderBar";
import {
  STANDALONE_PAGE_CONTAINER_CLASS,
  STANDALONE_PAGE_SCROLL_CLASS,
} from "./StandalonePageContent";

const targetPages = [
  "../automation/AutomationsPage.tsx",
  "../automation/AutomationDetailPage.tsx",
  "../automation/AutomationDetailPane.tsx",
  "../plugins/PluginDetailsPage.tsx",
  "../plugins/PluginStorePage.tsx",
  "../usage/UsagePage.tsx",
] as const;

describe("StandalonePageContent", () => {
  it("owns the shared page scrolling and Usage-derived container geometry", () => {
    expect(STANDALONE_PAGE_SCROLL_CLASS).toBe(
      "min-h-0 flex-1 overflow-y-auto overscroll-y-contain",
    );
    expect(STANDALONE_PAGE_CONTAINER_CLASS).toBe(
      "mx-auto w-full max-w-[56rem] px-16 py-7 sm:px-18",
    );
  });

  it("is used by every applicable centered standalone page", () => {
    for (const page of targetPages) {
      const source = readFileSync(new URL(page, import.meta.url), "utf8");
      expect(source).toContain("StandalonePageContent");
      expect(source).not.toMatch(/<StandalonePageContent[^>]*width=/);
      expect(source).not.toMatch(/<StandalonePageContent[^>]*contentClassName="[^"]*max-w-/);
      expect(source).not.toMatch(/<StandalonePageContent[^>]*contentClassName="[^"]*p[tyb]-/);
      expect(source).not.toContain("min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6");
    }
  });

  it("keeps title-bar center content truly centered between title and actions", () => {
    expect(CONTENT_PANEL_HEADER_CENTER_GRID_CLASS).toContain(
      "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]",
    );
  });
});
