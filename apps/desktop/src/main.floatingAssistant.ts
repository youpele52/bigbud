import { ipcMain, type App } from "electron";

import { createCompactLinkHandoffCoordinator } from "./main.compactLinkHandoff";
import { desktopIpcChannels } from "./main.channels";
import type { DesktopWindowRegistry } from "./window/DesktopWindowRegistry";
import type { DesktopPreferencesStore } from "./window/desktopPreferences";
import type { FloatingAssistantWindows } from "./window/floatingAssistantWindows";
import {
  isCompactChatLinkHandoff,
  isDesktopRendererReadyAction,
} from "./window/menuAction.validation";

interface RegisterFloatingAssistantIpcOptions {
  readonly appInstance: Pick<App, "quit" | "relaunch">;
  readonly channels: typeof desktopIpcChannels;
  readonly desktopPreferences: DesktopPreferencesStore;
  readonly floatingAssistantWindows: FloatingAssistantWindows;
  readonly openMainWindow: (threadId?: string) => void;
  readonly prepareForAppQuit: (reason: string) => void;
  readonly windowRegistry: DesktopWindowRegistry;
}

export function registerFloatingAssistantIpc(options: RegisterFloatingAssistantIpcOptions): void {
  const {
    appInstance,
    channels,
    desktopPreferences,
    floatingAssistantWindows,
    openMainWindow,
    prepareForAppQuit,
    windowRegistry,
  } = options;
  ipcMain.removeAllListeners(channels.getWindowRole);
  ipcMain.on(channels.getWindowRole, (event) => {
    event.returnValue = windowRegistry.getRole(event.sender);
  });
  const compactLinkHandoff = createCompactLinkHandoffCoordinator({
    getMainWindow: () => windowRegistry.get("main"),
    openMainWindow: () => {
      openMainWindow();
      const mainWindow = windowRegistry.get("main");
      if (!mainWindow) {
        console.error("[desktop] compact link handoff could not open the main window");
      }
      return mainWindow;
    },
    menuActionChannel: channels.menuAction,
  });
  ipcMain.removeAllListeners(channels.menuAction);
  ipcMain.on(channels.menuAction, (event, action: unknown) => {
    const senderRole = windowRegistry.getRole(event.sender);
    if (senderRole === "compact-chat" && isCompactChatLinkHandoff(action)) {
      compactLinkHandoff.request(action);
      return;
    }

    if (senderRole !== "main" || !isDesktopRendererReadyAction(action)) {
      return;
    }

    const mainWindow = windowRegistry.get("main");
    if (mainWindow?.webContents === event.sender) {
      compactLinkHandoff.markRendererReady(mainWindow);
    }
  });
  const register = (channel: string, handler: (value?: unknown) => unknown) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, value) => {
      if (!windowRegistry.isTrusted(event.sender)) return false;
      return handler(value);
    });
  };
  register(channels.openMainWindow, (threadId) => {
    openMainWindow(typeof threadId === "string" ? threadId : undefined);
    return true;
  });
  register(channels.openCompactChat, async () => {
    await floatingAssistantWindows.openCompactChat();
    return true;
  });
  register(channels.beginMascotDrag, (point) => floatingAssistantWindows.beginMascotDrag(point));
  register(channels.moveMascot, (point) => floatingAssistantWindows.moveMascot(point));
  register(channels.hideCompactChat, () => {
    floatingAssistantWindows.hideCompactChat();
    return true;
  });
  register(channels.hideMascot, () => {
    floatingAssistantWindows.hideMascot();
    return true;
  });
  register(channels.disableFloatingAssistant, () => {
    openMainWindow();
    floatingAssistantWindows.disable();
    return true;
  });
  register(channels.quitApplication, () => {
    prepareForAppQuit("floating-assistant-quit");
    appInstance.quit();
    return true;
  });
  register(channels.restartApplication, () => {
    appInstance.relaunch();
    prepareForAppQuit("settings-restart");
    appInstance.quit();
    return true;
  });
  register(
    channels.getFloatingAssistantEnabled,
    () => desktopPreferences.get().floatingAssistantEnabled,
  );
  register(
    channels.getFloatingAssistantCaller,
    () => desktopPreferences.get().floatingAssistantCaller,
  );
  register(channels.setFloatingAssistantEnabled, async (enabled) => {
    if (typeof enabled !== "boolean") return false;
    desktopPreferences.update({ floatingAssistantEnabled: enabled, mascotVisible: enabled });
    if (enabled) await floatingAssistantWindows.ensureMascot();
    else floatingAssistantWindows.disable();
    return true;
  });
  register(channels.setFloatingAssistantCaller, (caller) => {
    if (caller !== "chrome" && caller !== "logo" && caller !== "matte") return false;
    desktopPreferences.update({ floatingAssistantCaller: caller });
    windowRegistry.get("mascot")?.webContents.send(channels.floatingAssistantCallerChanged, caller);
    return true;
  });
}
