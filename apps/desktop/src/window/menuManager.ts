import * as FS from "node:fs";
import * as Path from "node:path";

import { app, BrowserWindow, dialog, Menu } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import type { DesktopUpdateState } from "@bigbud/contracts";

import { getAutoUpdateDisabledReason } from "../updater/updateState";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MenuManagerDeps {
  readonly menuActionChannel: string;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly setMainWindow: (w: BrowserWindow) => void;
  readonly makeWindow: () => BrowserWindow;
  readonly checkForUpdates: (reason: string) => Promise<boolean>;
  readonly getUpdateState: () => DesktopUpdateState;
  readonly isDevelopment: boolean;
}

// ---------------------------------------------------------------------------
// Safe external URL validation
// ---------------------------------------------------------------------------

export function getSafeExternalUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return null;
  }

  return parsedUrl.toString();
}

// ---------------------------------------------------------------------------
// Icon / resource resolution
// ---------------------------------------------------------------------------

export function resolveResourcePath(
  fileName: string,
  desktopDir: string,
  resourcesPath: string,
): string | null {
  const candidates = [
    Path.join(desktopDir, "../resources", fileName),
    Path.join(desktopDir, "../prod-resources", fileName),
    Path.join(resourcesPath, "resources", fileName),
    Path.join(resourcesPath, fileName),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function makeResolveIconPath(
  desktopDir: string,
  resourcesPath: string,
): (ext: "ico" | "icns" | "png") => string | null {
  return (ext) => resolveResourcePath(`icon.${ext}`, desktopDir, resourcesPath);
}

// ---------------------------------------------------------------------------
// Application menu
// ---------------------------------------------------------------------------

function dispatchMenuAction(deps: MenuManagerDeps, action: string): void {
  const existingWindow =
    BrowserWindow.getFocusedWindow() ?? deps.getMainWindow() ?? BrowserWindow.getAllWindows()[0];
  const targetWindow = existingWindow ?? deps.makeWindow();
  if (!existingWindow) {
    deps.setMainWindow(targetWindow);
  }

  const send = () => {
    if (targetWindow.isDestroyed()) return;
    targetWindow.webContents.send(deps.menuActionChannel, action);
    if (!targetWindow.isVisible()) {
      targetWindow.show();
    }
    targetWindow.focus();
  };

  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once("did-finish-load", send);
    return;
  }

  send();
}

async function checkForUpdatesFromMenu(deps: MenuManagerDeps): Promise<void> {
  await deps.checkForUpdates("menu");

  const state = deps.getUpdateState();
  if (state.status === "up-to-date") {
    void dialog.showMessageBox({
      type: "info",
      title: "You're up to date!",
      message: `bigbud ${state.currentVersion} is currently the newest version available.`,
      buttons: ["OK"],
    });
  } else if (state.status === "error") {
    void dialog.showMessageBox({
      type: "warning",
      title: "Update check failed",
      message: "Could not check for updates.",
      detail: state.message ?? "An unknown error occurred. Please try again later.",
      buttons: ["OK"],
    });
  }
}

function handleCheckForUpdatesMenuClick(deps: MenuManagerDeps): void {
  const disabledReason = getAutoUpdateDisabledReason({
    isDevelopment: deps.isDevelopment,
    isPackaged: app.isPackaged,
    platform: process.platform,
    appImage: process.env.APPIMAGE,
    disabledByEnv:
      (process.env.BIGBUD_DISABLE_AUTO_UPDATE ?? process.env.T3CODE_DISABLE_AUTO_UPDATE) === "1",
  });
  if (disabledReason) {
    console.info("[desktop-updater] Manual update check requested, but updates are disabled.");
    void dialog.showMessageBox({
      type: "info",
      title: "Updates unavailable",
      message: "Automatic updates are not available right now.",
      detail: disabledReason,
      buttons: ["OK"],
    });
    return;
  }

  if (!BrowserWindow.getAllWindows().length) {
    deps.setMainWindow(deps.makeWindow());
  }
  void checkForUpdatesFromMenu(deps);
}

export function configureApplicationMenu(deps: MenuManagerDeps): void {
  const template: MenuItemConstructorOptions[] = [];

  if (process.platform === "darwin") {
    template.push({
      label: app.name,
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates...",
          click: () => handleCheckForUpdatesMenuClick(deps),
        },
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "CmdOrCtrl+,",
          click: () => dispatchMenuAction(deps, "open-settings"),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push(
    {
      label: "File",
      submenu: [
        ...(process.platform === "darwin"
          ? []
          : [
              {
                label: "Settings...",
                accelerator: "CmdOrCtrl+,",
                click: () => dispatchMenuAction(deps, "open-settings"),
              },
              { type: "separator" as const },
            ]),
        { role: process.platform === "darwin" ? "close" : "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn", accelerator: "CmdOrCtrl+=" },
        { role: "zoomIn", accelerator: "CmdOrCtrl+Plus", visible: false },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Check for Updates...",
          click: () => handleCheckForUpdatesMenuClick(deps),
        },
      ],
    },
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
