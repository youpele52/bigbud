import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSearch = vi.hoisted(() => ({
  value: {
    thisComputer: true,
    connectedRemoteBackends: true,
    fileAccessLevel: "none" as "none" | "common-folders" | "unrestricted",
    hasSeenThisComputerHint: false,
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({ pathname: "/settings/ai", hash: "" }),
  useNavigate: () => vi.fn(),
}));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: (select: (settings: { search: typeof mockSearch.value }) => unknown) =>
    select({ search: mockSearch.value }),
  updateServerSettings: vi.fn(),
}));

import { SearchSettingsSection } from "./SearchSettingsSection";
import { SETTINGS_SEARCH_ITEMS } from "./SettingsSidebarNav.items";

function switchFor(markup: string, label: string): string {
  const match = markup.match(new RegExp(`<[^>]*aria-label="${label}"[^>]*>`));
  if (!match) throw new Error(`no switch ${label}`);
  return match[0];
}

describe("SearchSettingsSection", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    mockSearch.value = {
      thisComputer: true,
      connectedRemoteBackends: true,
      fileAccessLevel: "none",
      hasSeenThisComputerHint: false,
    };
  });

  it("defaults both toggles on, yet shows this computer off and disabled while File Access is none", () => {
    const markup = renderToStaticMarkup(<SearchSettingsSection />);
    expect(switchFor(markup, "Search this computer")).toContain('aria-checked="false"');
    expect(switchFor(markup, "Search this computer")).toMatch(
      /aria-disabled="true"|data-disabled=""/,
    );
    expect(markup).toContain("Turn on File Access above");
    expect(markup).toContain("Follows the File Access permission level");
    expect(markup).toContain("Go to File Access");
    expect(switchFor(markup, "Search connected remote backends")).toContain('aria-checked="true"');
  });

  it("enables the toggle and names the scope once File Access allows it", () => {
    mockSearch.value = {
      ...mockSearch.value,
      fileAccessLevel: "common-folders",
      thisComputer: true,
    };
    const markup = renderToStaticMarkup(<SearchSettingsSection />);
    expect(switchFor(markup, "Search this computer")).toContain('aria-checked="true"');
    expect(switchFor(markup, "Search this computer")).not.toMatch(
      /aria-disabled="true"|data-disabled=""/,
    );
    expect(markup).toContain("Desktop, Documents, Downloads, Music and Pictures");
  });

  it("is reachable from settings search on Settings › AI", () => {
    for (const label of ["Search this computer", "Search connected remote backends"]) {
      expect(SETTINGS_SEARCH_ITEMS).toContainEqual({ label, section: "AI", to: "/settings/ai" });
    }
  });
});
