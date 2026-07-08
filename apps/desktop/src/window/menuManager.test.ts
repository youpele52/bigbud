import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

import { configureApplicationMenu, getSafeExternalUrl, makeResolveIconPath } from "./menuManager";

function getViewMenuEntries(): readonly MenuTemplateEntry[] {
  const viewMenu = menuHarness.buildTemplate?.find((entry) => entry.label === "View");
  if (!viewMenu || !Array.isArray(viewMenu.submenu)) {
    throw new Error("Expected View menu entries to be configured.");
  }

  return viewMenu.submenu;
}

function collectAccelerators(entries: readonly MenuTemplateEntry[] | undefined): string[] {
  if (!entries) {
    return [];
  }

  return entries.flatMap((entry) => {
    const accelerators = entry.accelerator ? [entry.accelerator] : [];
    return accelerators.concat(collectAccelerators(entry.submenu));
  });
}

function getFileMenuEntries(): readonly MenuTemplateEntry[] {
  const fileMenu = menuHarness.buildTemplate?.find((entry) => entry.label === "File");
  if (!fileMenu || !Array.isArray(fileMenu.submenu)) {
    throw new Error("Expected File menu entries to be configured.");
  }

  return fileMenu.submenu;
}

function getWindowMenuEntries(): readonly MenuTemplateEntry[] {
  const windowMenu = menuHarness.buildTemplate?.find((entry) => entry.label === "Window");
  if (!windowMenu || !Array.isArray(windowMenu.submenu)) {
    throw new Error("Expected Window menu entries to be configured.");
  }

  return windowMenu.submenu;
}

describe("configureApplicationMenu", () => {
  it("does not bind mod+w to close the desktop window", () => {
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

    expect(collectAccelerators(menuHarness.buildTemplate ?? [])).not.toContain("CmdOrCtrl+W");

    if (process.platform === "darwin") {
      expect(getFileMenuEntries()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ role: "close" })]),
      );
      expect(getWindowMenuEntries()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ role: "close" })]),
      );
    }
  });

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

  it("prefers development desktop icons when running in development", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-menu-manager-"));
    const desktopDir = path.join(tempRoot, "apps", "desktop", "dist-electron");
    const developmentIconFileName =
      process.platform === "darwin" ? "blueprint-macos-1024.png" : "blueprint-universal-1024.png";
    const developmentIconPath = path.join(tempRoot, "assets", "dev", developmentIconFileName);

    fs.mkdirSync(path.dirname(developmentIconPath), { recursive: true });
    fs.mkdirSync(desktopDir, { recursive: true });
    fs.writeFileSync(developmentIconPath, "dev");

    try {
      const resolveIconPath = makeResolveIconPath(desktopDir, "", true);
      expect(resolveIconPath("png")).toBe(developmentIconPath);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("falls back to bundled resources when development desktop icons are unavailable", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-menu-manager-"));
    const desktopDir = path.join(tempRoot, "apps", "desktop", "dist-electron");
    const resourceIconPath = path.join(tempRoot, "apps", "desktop", "resources", "icon.png");

    fs.mkdirSync(path.dirname(resourceIconPath), { recursive: true });
    fs.mkdirSync(desktopDir, { recursive: true });
    fs.writeFileSync(resourceIconPath, "prod");

    try {
      const resolveIconPath = makeResolveIconPath(
        desktopDir,
        path.join(tempRoot, "missing-resources"),
        true,
      );
      expect(resolveIconPath("png")).toBe(resourceIconPath);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("prefers packaged resource icons outside app.asar when the app is installed", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-menu-manager-"));
    const resourcesPath = path.join(tempRoot, "bigbud.app", "Contents", "Resources");
    const desktopDir = path.join(resourcesPath, "app.asar", "apps", "desktop", "dist-electron");
    const asarIconPath = path.join(
      resourcesPath,
      "app.asar",
      "apps",
      "desktop",
      "resources",
      "icon.icns",
    );
    const packagedIconPath = path.join(resourcesPath, "icon.icns");

    fs.mkdirSync(path.dirname(asarIconPath), { recursive: true });
    fs.mkdirSync(path.dirname(packagedIconPath), { recursive: true });
    fs.mkdirSync(desktopDir, { recursive: true });
    fs.writeFileSync(asarIconPath, "asar");
    fs.writeFileSync(packagedIconPath, "packaged");

    try {
      const resolveIconPath = makeResolveIconPath(desktopDir, resourcesPath, false);
      expect(resolveIconPath("icns")).toBe(packagedIconPath);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("getSafeExternalUrl", () => {
  it("allows macOS System Settings deep links", () => {
    expect(
      getSafeExternalUrl(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      ),
    ).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
  });

  it("rejects unsupported protocols", () => {
    expect(getSafeExternalUrl("file:///etc/passwd")).toBeNull();
  });
});
