import { BrowserWindow, type WebContents } from "electron";

import { COMPUTER_USE_SAFETY_ROLE, type DesktopWindowRegistry } from "./DesktopWindowRegistry";

/**
 * Windows that may receive app-wide broadcasts and menu actions: every live
 * window except the restricted computer-use safety renderer, which must only
 * ever see its own fixed channels. Configured with the IPC authorizer; before
 * that no safety window exists, so nothing is excluded.
 */
let isRestricted: (contents: WebContents) => boolean = () => false;

export function configureRendererWindows(registry: Pick<DesktopWindowRegistry, "getRole">): void {
  isRestricted = (contents) => registry.getRole(contents) === COMPUTER_USE_SAFETY_ROLE;
}

export function broadRendererWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (window) => !window.isDestroyed() && !isRestricted(window.webContents),
  );
}
