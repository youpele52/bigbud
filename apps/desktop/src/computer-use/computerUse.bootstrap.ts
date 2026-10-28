import { app, type BrowserWindow } from "electron";

import type { DesktopWindowRegistry } from "../window/DesktopWindowRegistry";
import type { GuardHandle } from "./guardProcess";
import { startComputerUseGuardIfSelected } from "./guardProcess.bootstrap";
import type { GuardLaunchInput } from "./guardProcess.logic";
import { createComputerUseSafetyWindow, resolveSafetyWindowPaths } from "./safetyWindow";
import { registerComputerUseSafetyIpc, unavailableSafetyController } from "./safetyWindow.ipc";

/**
 * Desktop bootstrap wiring for supervised computer use, kept out of
 * `main.bootstrap.ts`. Quit integration is a `before-quit` registration here,
 * so the shared quit-action module needs no hook.
 */
const onBeforeQuit = (listener: () => void): void => {
  app.on("before-quit", listener);
};

export function startComputerUseGuard(
  input: GuardLaunchInput & { readonly log: (message: string) => void },
): GuardHandle | null {
  return startComputerUseGuardIfSelected({ ...input, onBeforeQuit });
}

/** Sends once the target document has loaded (a fresh window may still be loading). */
export function sendWhenLoaded(window: BrowserWindow, channel: string, payload: string): void {
  const send = () => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  };
  if (window.webContents.isLoadingMainFrame()) {
    window.webContents.once("did-finish-load", send);
    return;
  }
  send();
}

/**
 * Restricted safety channels; until the native control channel exists the
 * controller reports `unavailable` and Stop revokes nothing (none admitted).
 * The Stop surface exists only while a guard was started.
 */
export function registerComputerUseSafetySurface(input: {
  readonly registry: DesktopWindowRegistry;
  readonly desktopDir: string;
  readonly guard: GuardHandle | null;
  readonly openMainWindow: () => BrowserWindow;
  readonly menuActionChannel: string;
}): void {
  registerComputerUseSafetyIpc(
    unavailableSafetyController(() => {
      sendWhenLoaded(input.openMainWindow(), input.menuActionChannel, "open-settings");
    }),
  );
  if (!input.guard) return;
  const safetyWindow = createComputerUseSafetyWindow({
    registry: input.registry,
    paths: resolveSafetyWindowPaths(input.desktopDir),
    onBeforeQuit,
  });
  safetyWindow.once("ready-to-show", () => safetyWindow.showInactive());
}
