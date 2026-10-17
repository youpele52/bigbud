import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSettings = vi.hoisted(() => ({
  delegatedThreadModelChoice: "agent" as "agent" | "parent",
}));

vi.mock("../../hooks/useSettings", () => ({
  useSettings: (select: (settings: typeof mockSettings) => unknown) => select(mockSettings),
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
}));

import { DelegatedThreadsSettingsSection } from "./DelegatedThreadsSettingsSection";
import { SETTINGS_SEARCH_ITEMS } from "./SettingsSidebarNav.items";

describe("DelegatedThreadsSettingsSection", () => {
  beforeEach(() => {
    mockSettings.delegatedThreadModelChoice = "agent";
  });

  it("defaults to letting agents choose, with no reset action", () => {
    const markup = renderToStaticMarkup(<DelegatedThreadsSettingsSection />);
    expect(markup).toContain("Let agents choose models for delegated threads");
    expect(markup).toContain('aria-checked="true"');
    expect(markup).not.toMatch(/reset delegated thread model choice/i);
  });

  it("shows the parent-model setting as off with a reset action", () => {
    mockSettings.delegatedThreadModelChoice = "parent";
    const markup = renderToStaticMarkup(<DelegatedThreadsSettingsSection />);
    expect(markup).toContain('aria-checked="false"');
    expect(markup).toMatch(/reset delegated thread model choice/i);
  });

  it("is reachable from settings search", () => {
    expect(SETTINGS_SEARCH_ITEMS).toEqual(
      expect.arrayContaining([
        {
          label: "Let agents choose models for delegated threads",
          section: "AI",
          to: "/settings/ai",
        },
      ]),
    );
  });
});
