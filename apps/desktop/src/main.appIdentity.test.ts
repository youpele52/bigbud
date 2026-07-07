import { afterEach, describe, expect, it, vi } from "vitest";

const electronApp = vi.hoisted(() => ({
  dock: {
    setIcon: vi.fn(),
  },
  getVersion: vi.fn(() => "1.2.3"),
  isPackaged: false,
  setAboutPanelOptions: vi.fn(),
  setAppUserModelId: vi.fn(),
  setName: vi.fn(),
}));

vi.mock("electron", () => ({
  app: electronApp,
}));

vi.mock("./env/pathResolver", () => ({
  resolveAboutCommitHash: vi.fn(() => "abc123"),
}));

import { configureAppIdentity } from "./main.appIdentity";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

describe("configureAppIdentity", () => {
  afterEach(() => {
    setPlatform(originalPlatform);
    electronApp.dock.setIcon.mockClear();
    electronApp.getVersion.mockClear();
    electronApp.setAboutPanelOptions.mockClear();
    electronApp.setAppUserModelId.mockClear();
    electronApp.setName.mockClear();
    electronApp.isPackaged = false;
  });

  it("does not set the dock icon from the app bundle in packaged macOS builds", () => {
    setPlatform("darwin");
    electronApp.isPackaged = true;
    const resolveIconPath = vi.fn(() => "/Applications/bigbud.app/Contents/Resources/icon.icns");

    configureAppIdentity({
      appDisplayName: "bigbud",
      appUserModelId: "ai.bigbud.desktop",
      legacyUserDataDirName: "T3 Code (Alpha)",
      linuxDesktopEntryName: "bigbud.desktop",
      resolveIconPath,
      rootDir: "/repo",
      userDataDirName: "bigbud",
    });

    expect(resolveIconPath).not.toHaveBeenCalled();
    expect(electronApp.dock.setIcon).not.toHaveBeenCalled();
  });

  it("sets a development dock icon from png resources on macOS", () => {
    setPlatform("darwin");
    const resolveIconPath = vi.fn(() => "/repo/assets/dev/blueprint-macos-1024.png");

    configureAppIdentity({
      appDisplayName: "bigbud (Dev)",
      appUserModelId: "ai.bigbud.desktop",
      legacyUserDataDirName: "T3 Code (Dev)",
      linuxDesktopEntryName: "bigbud-dev.desktop",
      resolveIconPath,
      rootDir: "/repo",
      userDataDirName: "bigbud-dev",
    });

    expect(resolveIconPath).toHaveBeenCalledWith("png");
    expect(electronApp.dock.setIcon).toHaveBeenCalledWith(
      "/repo/assets/dev/blueprint-macos-1024.png",
    );
  });
});
