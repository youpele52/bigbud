import * as Path from "node:path";

import { BrowserWindow, Menu, shell } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { hardenBrowserGuestPreferences } from "./browserGuestPreferences";
import { isAllowedBrowserNavigation } from "./browserNavigationPolicy";
import { bindBrowserPopups } from "./browserPopups";
import {
  BROWSER_SESSION_PARTITION,
  initializeBrowserSession,
  isBrowserGuest,
} from "./browserSession";
import { certificateChallengeManager } from "./certificateChallengeManager";
import { isBrowserGuestFocusLocationShortcut } from "./browserGuestShortcuts";
import { bindTrafficLightsToZoom, trafficLightPositionForZoom } from "./trafficLights";
import { desktopIpcChannels } from "../main.channels";
import { bindWindowMaterial, getOpaqueBackgroundColor } from "./windowManager.material";

function getDevelopmentWindowUrl(devServerUrl: string): string {
  if (process.env.BIGBUD_DESKTOP_UPDATE_PREVIEW !== "downloading") {
    return devServerUrl;
  }

  const url = new URL(devServerUrl);
  url.searchParams.set("previewUpdate", "downloading");
  return url.toString();
}

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
  readonly menuActionChannel: string;
  readonly spellcheckEnabled: boolean;
  readonly resolveIconPath: (ext: "ico" | "icns" | "png") => string | null;
  readonly getSafeExternalUrl: (url: unknown) => string | null;
  readonly emitUpdateState: () => void;
  readonly onWindowClosed: (window: BrowserWindow) => void;
}

export function createWindow(deps: CreateWindowDeps): BrowserWindow {
  initializeBrowserSession();
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
    trafficLightPosition: trafficLightPositionForZoom(1),
    backgroundColor: getOpaqueBackgroundColor(),
    ...(process.platform === "darwin"
      ? {
          transparent: true,
          visualEffectState: "active" as const,
        }
      : {}),
    webPreferences: {
      preload: Path.join(deps.desktopDir, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: true,
      spellcheck: deps.spellcheckEnabled,
      webviewTag: true,
    },
  });
  const hostWebContents = window.webContents;
  bindTrafficLightsToZoom(window, desktopIpcChannels.windowZoomChanged);

  bindWindowMaterial(window);

  // Grant microphone permission requests from the renderer so that
  // navigator.mediaDevices.getUserMedia works inside Electron's sandboxed
  // process. Without this handler Electron denies all media permission
  // requests by default.
  window.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      if (
        permission === "media" &&
        (details as { mediaTypes?: string[] }).mediaTypes?.includes("audio")
      ) {
        callback(true);
        return;
      }
      // Deny everything else by default.
      callback(false);
    },
  );

  // Also set a permission check handler so Permissions API queries
  // (navigator.permissions.query) return the correct state for microphone.
  window.webContents.session.setPermissionCheckHandler(
    (_webContents, permission, _origin, details) => {
      if (permission === "media" && (details as { mediaType?: string }).mediaType === "audio") {
        return true;
      }
      return false;
    },
  );

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

  window.on("app-command", (_event, command) => {
    if (command === "browser-backward" || command === "browser-forward") {
      window.webContents.send(deps.menuActionChannel, command);
    }
  });

  window.webContents.on("did-attach-webview", (_event, guestWebContents) => {
    certificateChallengeManager.attachGuest(window.webContents, guestWebContents);
    if (isBrowserGuest(guestWebContents)) {
      bindBrowserPopups(window, guestWebContents);
      guestWebContents.on("before-input-event", (inputEvent, input) => {
        if (!isBrowserGuestFocusLocationShortcut(input)) return;
        inputEvent.preventDefault();
        window.webContents.send(deps.menuActionChannel, "focus-browser-location");
      });
    }
    guestWebContents.on("before-mouse-event", (_mouseEvent, input) => {
      if (input.type === "mouseDown" && input.button === "left") {
        window.webContents.send(deps.menuActionChannel, "close-browser-context-menu");
      }
    });
  });

  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (params.partition === BROWSER_SESSION_PARTITION) {
      if (!isAllowedBrowserNavigation(params.src ?? "about:blank", { allowAboutBlank: true })) {
        event.preventDefault();
        return;
      }
      hardenBrowserGuestPreferences(webPreferences);
    }
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
    void window.loadURL(getDevelopmentWindowUrl(process.env.VITE_DEV_SERVER_URL as string));
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    void window.loadURL(`${deps.desktopScheme}://app/index.html`);
  }

  window.on("closed", () => {
    certificateChallengeManager.closeHost(hostWebContents);
    deps.onWindowClosed(window);
  });

  return window;
}
