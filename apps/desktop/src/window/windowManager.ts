import * as Path from "node:path";

import { BrowserWindow, Menu, shell } from "electron";
import type { MenuItemConstructorOptions } from "electron";

// ---------------------------------------------------------------------------
// Icon resolution
// ---------------------------------------------------------------------------

/**
 * Returns `{ icon: <path> }` for non-macOS platforms, or `{}` on macOS (which
 * uses the .icns from the app bundle automatically).
 */
export function getIconOption(
  resolveIconPath: (ext: "ico" | "icns" | "png") => string | null,
): { icon: string } | Record<string, never> {
  if (process.platform === "darwin") return {}; // macOS uses .icns from app bundle
  const ext = process.platform === "win32" ? "ico" : "png";
  const iconPath = resolveIconPath(ext);
  return iconPath ? { icon: iconPath } : {};
}

// ---------------------------------------------------------------------------
// Window factory
// ---------------------------------------------------------------------------

export interface CreateWindowDeps {
  readonly appDisplayName: string;
  readonly desktopScheme: string;
  readonly isDevelopment: boolean;
  readonly desktopDir: string;
  readonly resolveIconPath: (ext: "ico" | "icns" | "png") => string | null;
  readonly getSafeExternalUrl: (url: unknown) => string | null;
  readonly emitUpdateState: () => void;
  readonly onWindowClosed: (window: BrowserWindow) => void;
}

export function createWindow(deps: CreateWindowDeps): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 840,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    ...getIconOption(deps.resolveIconPath),
    title: deps.appDisplayName,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: Path.join(deps.desktopDir, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.on("context-menu", (event, params) => {
    event.preventDefault();

    const menuTemplate: MenuItemConstructorOptions[] = [];

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        menuTemplate.push({
          label: suggestion,
          click: () => window.webContents.replaceMisspelling(suggestion),
        });
      }
      if (params.dictionarySuggestions.length === 0) {
        menuTemplate.push({ label: "No suggestions", enabled: false });
      }
      menuTemplate.push({ type: "separator" });
    }

    if (params.mediaType === "image") {
      menuTemplate.push({
        label: "Copy Image",
        click: () => window.webContents.copyImageAt(params.x, params.y),
      });
      menuTemplate.push({ type: "separator" });
    }

    menuTemplate.push(
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    );

    Menu.buildFromTemplate(menuTemplate).popup({ window });
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = deps.getSafeExternalUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl);
    }
    return { action: "deny" };
  });

  window.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(deps.appDisplayName);
  });
  window.webContents.on("did-finish-load", () => {
    window.setTitle(deps.appDisplayName);
    deps.emitUpdateState();
  });
  window.once("ready-to-show", () => {
    window.show();
  });

  if (deps.isDevelopment) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL as string);
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    void window.loadURL(`${deps.desktopScheme}://app/index.html`);
  }

  window.on("closed", () => {
    deps.onWindowClosed(window);
  });

  return window;
}
