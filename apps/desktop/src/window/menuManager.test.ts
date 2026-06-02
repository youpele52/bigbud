import { describe, expect, it, vi } from "vitest";

const menuHarness = vi.hoisted(() => ({
  buildTemplate: null as readonly MenuTemplateEntry[] | null,
  setApplicationMenu: vi.fn(),
}));

type MenuTemplateEntry = {
  accelerator?: string;
  click?: (...args: unknown[]) => void;
  label?: string;
  role?: string;
  submenu?: readonly MenuTemplateEntry[];
  type?: "separator";
};

const focusedWindow = {
  focus: vi.fn(),
  isDestroyed: vi.fn(() => false),
  isVisible: vi.fn(() => true),
  show: vi.fn(),
  webContents: {
    isLoadingMainFrame: vi.fn(() => false),
    once: vi.fn(),
    send: vi.fn(),
  },
};

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    name: "bigbud",
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [focusedWindow]),
    getFocusedWindow: vi.fn(() => focusedWindow),
  },
  dialog: {
    showMessageBox: vi.fn(),
  },
  Menu: {
    buildFromTemplate: vi.fn((template) => {
      menuHarness.buildTemplate = template as readonly MenuTemplateEntry[];
      return { template };
    }),
    setApplicationMenu: menuHarness.setApplicationMenu,
  },
}));

import { configureApplicationMenu } from "./menuManager";

function getViewMenuEntries(): readonly MenuTemplateEntry[] {
  const viewMenu = menuHarness.buildTemplate?.find((entry) => entry.label === "View");
  if (!viewMenu || !Array.isArray(viewMenu.submenu)) {
    throw new Error("Expected View menu entries to be configured.");
  }

  return viewMenu.submenu;
}

describe("configureApplicationMenu", () => {
  it("replaces full-app reload roles with browser reload actions", () => {
    menuHarness.buildTemplate = null;

    configureApplicationMenu({
      menuActionChannel: "desktop:menu-action",
      getMainWindow: () => focusedWindow as never,
      setMainWindow: vi.fn(),
      makeWindow: () => focusedWindow as never,
      checkForUpdates: async () => false,
      getUpdateState: () => ({ status: "idle" }) as never,
      isDevelopment: false,
    });

    const viewMenuEntries = getViewMenuEntries();

    expect(viewMenuEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accelerator: "CmdOrCtrl+R",
          label: "Reload Browser",
        }),
        expect.objectContaining({
          accelerator: "Shift+CmdOrCtrl+R",
          label: "Reload Browser and Ignore Cache",
        }),
      ]),
    );
    expect(viewMenuEntries).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "reload" }),
        expect.objectContaining({ role: "forceReload" }),
      ]),
    );
  });

  it("dispatches browser reload actions through the menu action bridge", () => {
    menuHarness.buildTemplate = null;
    focusedWindow.webContents.send.mockClear();

    configureApplicationMenu({
      menuActionChannel: "desktop:menu-action",
      getMainWindow: () => focusedWindow as never,
      setMainWindow: vi.fn(),
      makeWindow: () => focusedWindow as never,
      checkForUpdates: async () => false,
      getUpdateState: () => ({ status: "idle" }) as never,
      isDevelopment: false,
    });

    const viewMenuEntries = getViewMenuEntries();
    const reloadBrowser = viewMenuEntries.find((entry) => entry.label === "Reload Browser");
    const reloadIgnoringCache = viewMenuEntries.find(
      (entry) => entry.label === "Reload Browser and Ignore Cache",
    );

    reloadBrowser?.click?.();
    reloadIgnoringCache?.click?.();

    expect(focusedWindow.webContents.send).toHaveBeenNthCalledWith(
      1,
      "desktop:menu-action",
      "reload-browser",
    );
    expect(focusedWindow.webContents.send).toHaveBeenNthCalledWith(
      2,
      "desktop:menu-action",
      "reload-browser-ignoring-cache",
    );
  });
});
