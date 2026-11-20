import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({
  location: { pathname: "/settings/ai", hash: "" },
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useLocation: () => mocks.location,
  useNavigate: () => mocks.navigate,
}));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: (select?: (settings: unknown) => unknown) => {
    const settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      fileAccessPermissionLevel: "common-folders",
      search: { ...DEFAULT_UNIFIED_SETTINGS.search, fileAccessLevel: "common-folders" },
    };
    return select ? select(settings) : settings;
  },
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
  updateServerSettings: vi.fn(),
}));
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => undefined }));

import { FileAccessSettingsSection } from "./FileAccessSettingsSection";
import { SearchSettingsSection } from "./SearchSettingsSection";
import { SETTINGS_ANCHORS } from "./settingsAnchor";

function Sections() {
  return (
    <>
      <FileAccessSettingsSection />
      <SearchSettingsSection />
    </>
  );
}

afterEach(() => {
  mocks.location = { pathname: "/settings/ai", hash: "" };
  mocks.navigate.mockReset();
  vi.restoreAllMocks();
});

describe("Search ↔ File Access cross-links", () => {
  it("links from Search this computer to the File Access permission level", async () => {
    const screen = await render(<Sections />);
    const link = screen.getByRole("button", { name: "Go to File Access" });
    await expect.element(link).toBeVisible();
    await link.click();
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/settings/ai",
      hash: SETTINGS_ANCHORS.fileAccessPermissionLevel,
    });
  });

  it("links from the File Access permission level to Search this computer", async () => {
    const screen = await render(<Sections />);
    await screen.getByRole("button", { name: "Go to Search this computer" }).click();
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/settings/ai",
      hash: SETTINGS_ANCHORS.searchThisComputer,
    });
  });

  it.each([
    [SETTINGS_ANCHORS.fileAccessPermissionLevel, "File access permission level"],
    [SETTINGS_ANCHORS.searchThisComputer, "Search this computer"],
  ])("scrolls to, focuses and briefly highlights #%s", async (hash, controlName) => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    mocks.location = { ...mocks.location, hash };
    const screen = await render(<Sections />);
    const row = document.getElementById(hash)!;
    await expect.poll(() => row.hasAttribute("data-settings-highlighted")).toBe(true);
    expect(scroll).toHaveBeenCalledWith({ block: "center" });
    await expect.element(screen.getByLabelText(controlName)).toHaveFocus();
    expect(document.querySelectorAll("[data-settings-highlighted]")).toHaveLength(1);
  });
});
