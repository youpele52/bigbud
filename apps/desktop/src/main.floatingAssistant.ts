import type { AppQuitActions } from "./main.appQuitActions";
import { createCompactLinkHandoffCoordinator } from "./main.compactLinkHandoff";
import { desktopIpcChannels } from "./main.channels";
import { registerCompactScreenshotIpc } from "./window/ipcHandlers.compactScreenshot";
import { authorizedHandle, authorizedOn, BROAD_RENDERER_ROLES } from "./window/ipcAuthorization";
import type { DesktopWindowRegistry } from "./window/DesktopWindowRegistry";
import type { DesktopPreferencesStore } from "./window/desktopPreferences";
import type { FloatingAssistantWindows } from "./window/floatingAssistantWindows";
import {
  isCompactChatLinkHandoff,
  isDesktopRendererReadyAction,
} from "./window/menuAction.validation";

const MASCOT_RENDERER_ROLES = ["mascot"] as const;

interface RegisterFloatingAssistantIpcOptions {
  readonly appQuitActions: AppQuitActions;
  readonly channels: typeof desktopIpcChannels;
  readonly desktopPreferences: DesktopPreferencesStore;
  readonly floatingAssistantWindows: FloatingAssistantWindows;
  readonly openMainWindow: (threadId?: string) => void;
  readonly windowRegistry: DesktopWindowRegistry;
}

export function registerFloatingAssistantIpc(options: RegisterFloatingAssistantIpcOptions): void {
  const {
    appQuitActions,
    channels,
    desktopPreferences,
    floatingAssistantWindows,
    openMainWindow,
    windowRegistry,
  } = options;
  registerCompactScreenshotIpc(windowRegistry, floatingAssistantWindows.screenshots.handoff);
  authorizedOn(channels.getWindowRole, BROAD_RENDERER_ROLES, (event) => {
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
  authorizedOn(channels.menuAction, BROAD_RENDERER_ROLES, (event, action: unknown) => {
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
    authorizedHandle(channel, BROAD_RENDERER_ROLES, (event, value) => {
      if (!windowRegistry.isTrusted(event.sender)) return false;
      return handler(value);
    });
  };
  // Only the mascot renderer drives its own menu; a stray report cannot show the item.
  authorizedHandle(channels.setMascotComputerUseActive, MASCOT_RENDERER_ROLES, (event, active) => {
    if (!windowRegistry.isTrusted(event.sender) || typeof active !== "boolean") return false;
    return floatingAssistantWindows.computerUse.setActive(event.sender.id, active);
  });
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
    appQuitActions.quit("floating-assistant-quit");
    return true;
  });
  register(channels.restartApplication, () => {
    appQuitActions.restart("settings-restart");
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
