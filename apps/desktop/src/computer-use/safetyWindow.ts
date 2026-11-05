import * as Path from "node:path";
import { pathToFileURL } from "node:url";

import { BrowserWindow, session } from "electron";

import {
  COMPUTER_USE_SAFETY_ROLE,
  type DesktopWindowRegistry,
} from "../window/DesktopWindowRegistry";
import { COMPUTER_USE_SAFETY_PARTITION } from "./safetyWindow.channels";

export interface SafetyWindowPaths {
  /** Built restricted preload (`dist-electron/computerUseSafety.preload.js`). */
  readonly preloadPath: string;
  /** Fixed bundled page (`resources/computer-use-safety/safety.html`). */
  readonly pagePath: string;
}

export function resolveSafetyWindowPaths(desktopDir: string): SafetyWindowPaths {
  return {
    preloadPath: Path.join(desktopDir, "computerUseSafety.preload.js"),
    pagePath: Path.join(desktopDir, "..", "resources", "computer-use-safety", "safety.html"),
  };
}

/**
 * Locks an ephemeral (non-persistent) session down to the fixed page: every
 * other request is cancelled (network, localhost included), permissions,
 * downloads, new windows, navigation and webviews are denied.
 */
export function lockDownSafetySession(target: Electron.Session, pageDirectoryUrl: string): void {
  target.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(pageDirectoryUrl) });
  });
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
  target.on("will-download", (event) => event.preventDefault());
}

export function lockDownSafetyContents(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
}

/** Window chrome: no close button, never focusable (menu accelerators such
 * as Cmd+W cannot target it), not resizable, always on top. */
export const SAFETY_WINDOW_CHROME = {
  width: 280,
  height: 132,
  show: false,
  frame: false,
  closable: false,
  focusable: false,
  resizable: false,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  skipTaskbar: true,
  alwaysOnTop: true,
} as const satisfies Electron.BrowserWindowConstructorOptions;

/**
 * The Stop surface must not be closed for the session: any close is refused
 * until quit starts, then the window is destroyed so it cannot block quit.
 */
export function keepSafetyWindowUntilQuit(
  window: Pick<BrowserWindow, "on" | "destroy" | "isDestroyed">,
  onBeforeQuit: (listener: () => void) => void,
): void {
  let quitting = false;
  onBeforeQuit(() => {
    quitting = true;
    if (!window.isDestroyed()) window.destroy();
  });
  window.on("close", (event: Electron.Event) => {
    if (!quitting) event.preventDefault();
  });
}

/**
 * The always-on-top Stop/status/notice surface (plan M4.surface). Independent
 * of the floating assistant; registered under the restricted safety role, so
 * every broad IPC channel, broadcast and menu action excludes it. Visibility
 * and clickability across displays and full-screen contexts are NOT qualified.
 */
export function createComputerUseSafetyWindow(input: {
  readonly registry: DesktopWindowRegistry;
  readonly paths: SafetyWindowPaths;
  readonly onBeforeQuit: (listener: () => void) => void;
}): BrowserWindow {
  const safetySession = session.fromPartition(COMPUTER_USE_SAFETY_PARTITION);
  const pageDirectoryUrl = pathToFileURL(Path.dirname(input.paths.pagePath)).href + "/";
  lockDownSafetySession(safetySession, pageDirectoryUrl);
  const window = new BrowserWindow({
    ...SAFETY_WINDOW_CHROME,
    webPreferences: {
      preload: input.paths.preloadPath,
      session: safetySession,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
    },
  });
  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  lockDownSafetyContents(window.webContents);
  keepSafetyWindowUntilQuit(window, input.onBeforeQuit);
  input.registry.register(COMPUTER_USE_SAFETY_ROLE, window);
  void window.loadFile(input.paths.pagePath);
  return window;
}
