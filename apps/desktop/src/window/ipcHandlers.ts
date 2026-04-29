import {
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  shell,
} from "electron";
import type { MenuItemConstructorOptions } from "electron";
import type {
  ContextMenuItem,
  DesktopNotificationInput,
  DesktopTheme,
  DesktopUpdateActionResult,
  DesktopUpdateCheckResult,
  DesktopUpdateState,
} from "@bigbud/contracts";

import { showDesktopConfirmDialog } from "./confirmDialog";
import { getSafeExternalUrl } from "./menuManager";
import { getDestructiveMenuIcon } from "../env/pathResolver";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getSafeTheme(rawTheme: unknown): DesktopTheme | null {
  if (rawTheme === "light" || rawTheme === "dark" || rawTheme === "system") {
    return rawTheme;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Desktop notification
// ---------------------------------------------------------------------------

/**
 * Show a native OS desktop notification and wire up a click handler that
 * restores and focuses the main window.
 */
export function showDesktopNotification(
  input: DesktopNotificationInput,
  resolveIconPath: (ext: "ico" | "icns" | "png") => string | null,
  getMainWindow: () => BrowserWindow | null,
): boolean {
  if (!Notification.isSupported()) {
    return false;
  }

  const { title, body, silent } = input;
  if (typeof title !== "string" || title.trim().length === 0) {
    return false;
  }

  const iconPath = resolveIconPath("png");
  const notification = new Notification({
    title,
    ...(typeof body === "string" && body.length > 0 ? { body } : {}),
    ...(silent === true ? { silent: true } : {}),
    ...(iconPath ? { icon: iconPath } : {}),
  });

  notification.on("click", () => {
    const window = getMainWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  notification.show();
  return true;
}

// ---------------------------------------------------------------------------
// IPC handler registration
// ---------------------------------------------------------------------------

export interface IpcHandlerDeps {
  // Channel names
  readonly PICK_FOLDER_CHANNEL: string;
  readonly CONFIRM_CHANNEL: string;
  readonly SET_THEME_CHANNEL: string;
  readonly CONTEXT_MENU_CHANNEL: string;
  readonly OPEN_EXTERNAL_CHANNEL: string;
  readonly GET_WS_URL_CHANNEL: string;
  readonly NOTIFICATIONS_IS_SUPPORTED_CHANNEL: string;
  readonly NOTIFICATIONS_SHOW_CHANNEL: string;
  readonly COPY_TO_CLIPBOARD_CHANNEL: string;
  readonly UPDATE_GET_STATE_CHANNEL: string;
  readonly UPDATE_DOWNLOAD_CHANNEL: string;
  readonly UPDATE_INSTALL_CHANNEL: string;
  readonly UPDATE_CHECK_CHANNEL: string;

  // State/action accessors
  readonly getMainWindow: () => BrowserWindow | null;
  readonly getBackendWsUrl: () => string;
  readonly getIsQuitting: () => boolean;
  readonly getUpdateState: () => DesktopUpdateState;
  readonly isUpdaterConfigured: () => boolean;

  // Update actions
  readonly checkForUpdates: (reason: string) => Promise<boolean>;
  readonly downloadAvailableUpdate: () => Promise<{ accepted: boolean; completed: boolean }>;
  readonly installDownloadedUpdate: () => Promise<{ accepted: boolean; completed: boolean }>;

  // Icon resolver (for notifications)
  readonly resolveIconPath: (ext: "ico" | "icns" | "png") => string | null;
}

export function registerIpcHandlers(deps: IpcHandlerDeps): void {
  const {
    PICK_FOLDER_CHANNEL,
    CONFIRM_CHANNEL,
    SET_THEME_CHANNEL,
    CONTEXT_MENU_CHANNEL,
    OPEN_EXTERNAL_CHANNEL,
    GET_WS_URL_CHANNEL,
    NOTIFICATIONS_IS_SUPPORTED_CHANNEL,
    NOTIFICATIONS_SHOW_CHANNEL,
    COPY_TO_CLIPBOARD_CHANNEL,
    UPDATE_GET_STATE_CHANNEL,
    UPDATE_DOWNLOAD_CHANNEL,
    UPDATE_INSTALL_CHANNEL,
    UPDATE_CHECK_CHANNEL,
  } = deps;

  ipcMain.removeAllListeners(GET_WS_URL_CHANNEL);
  ipcMain.on(GET_WS_URL_CHANNEL, (event) => {
    event.returnValue = deps.getBackendWsUrl();
  });

  ipcMain.removeHandler(PICK_FOLDER_CHANNEL);
  ipcMain.handle(PICK_FOLDER_CHANNEL, async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? deps.getMainWindow();
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          properties: ["openDirectory", "createDirectory"],
        })
      : await dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
        });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.removeHandler(CONFIRM_CHANNEL);
  ipcMain.handle(CONFIRM_CHANNEL, async (_event, message: unknown) => {
    if (typeof message !== "string") {
      return false;
    }

    const owner = BrowserWindow.getFocusedWindow() ?? deps.getMainWindow();
    return showDesktopConfirmDialog(message, owner);
  });

  ipcMain.removeHandler(SET_THEME_CHANNEL);
  ipcMain.handle(SET_THEME_CHANNEL, async (_event, rawTheme: unknown) => {
    const theme = getSafeTheme(rawTheme);
    if (!theme) {
      return;
    }

    nativeTheme.themeSource = theme;
  });

  ipcMain.removeHandler(CONTEXT_MENU_CHANNEL);
  ipcMain.handle(
    CONTEXT_MENU_CHANNEL,
    async (_event, items: ContextMenuItem[], position?: { x: number; y: number }) => {
      const normalizedItems = items
        .filter((item) => typeof item.id === "string" && typeof item.label === "string")
        .map((item) => ({
          id: item.id,
          label: item.label,
          destructive: item.destructive === true,
          disabled: item.disabled === true,
        }));
      if (normalizedItems.length === 0) {
        return null;
      }

      const popupPosition =
        position &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y) &&
        position.x >= 0 &&
        position.y >= 0
          ? {
              x: Math.floor(position.x),
              y: Math.floor(position.y),
            }
          : null;

      const window = BrowserWindow.getFocusedWindow() ?? deps.getMainWindow();
      if (!window) return null;

      return new Promise<string | null>((resolve) => {
        const template: MenuItemConstructorOptions[] = [];
        let hasInsertedDestructiveSeparator = false;
        for (const item of normalizedItems) {
          if (item.destructive && !hasInsertedDestructiveSeparator && template.length > 0) {
            template.push({ type: "separator" });
            hasInsertedDestructiveSeparator = true;
          }
          const itemOption: MenuItemConstructorOptions = {
            label: item.label,
            enabled: !item.disabled,
            click: () => resolve(item.id),
          };
          if (item.destructive) {
            const destructiveIcon = getDestructiveMenuIcon();
            if (destructiveIcon) {
              itemOption.icon = destructiveIcon;
            }
          }
          template.push(itemOption);
        }

        const menu = Menu.buildFromTemplate(template);
        menu.popup({
          window,
          ...popupPosition,
          callback: () => resolve(null),
        });
      });
    },
  );

  ipcMain.removeHandler(OPEN_EXTERNAL_CHANNEL);
  ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (_event, rawUrl: unknown) => {
    const externalUrl = getSafeExternalUrl(rawUrl);
    if (!externalUrl) {
      return false;
    }

    try {
      await shell.openExternal(externalUrl);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.removeHandler(UPDATE_GET_STATE_CHANNEL);
  ipcMain.handle(UPDATE_GET_STATE_CHANNEL, async () => deps.getUpdateState());

  ipcMain.removeHandler(UPDATE_DOWNLOAD_CHANNEL);
  ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, async () => {
    const result = await deps.downloadAvailableUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: deps.getUpdateState(),
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(UPDATE_INSTALL_CHANNEL);
  ipcMain.handle(UPDATE_INSTALL_CHANNEL, async () => {
    if (deps.getIsQuitting()) {
      return {
        accepted: false,
        completed: false,
        state: deps.getUpdateState(),
      } satisfies DesktopUpdateActionResult;
    }
    const result = await deps.installDownloadedUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: deps.getUpdateState(),
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(UPDATE_CHECK_CHANNEL);
  ipcMain.handle(UPDATE_CHECK_CHANNEL, async () => {
    if (!deps.isUpdaterConfigured()) {
      return {
        checked: false,
        state: deps.getUpdateState(),
      } satisfies DesktopUpdateCheckResult;
    }
    const checked = await deps.checkForUpdates("web-ui");
    return {
      checked,
      state: deps.getUpdateState(),
    } satisfies DesktopUpdateCheckResult;
  });

  ipcMain.removeHandler(NOTIFICATIONS_IS_SUPPORTED_CHANNEL);
  ipcMain.handle(NOTIFICATIONS_IS_SUPPORTED_CHANNEL, () => Notification.isSupported());

  ipcMain.removeHandler(NOTIFICATIONS_SHOW_CHANNEL);
  ipcMain.handle(NOTIFICATIONS_SHOW_CHANNEL, (_event, input: unknown) => {
    if (typeof input !== "object" || input === null) {
      return false;
    }
    const { title, body, silent } = input as Record<string, unknown>;
    return showDesktopNotification(
      {
        title: typeof title === "string" ? title : "",
        ...(typeof body === "string" ? { body } : {}),
        ...(silent === true ? { silent: true } : {}),
      },
      deps.resolveIconPath,
      deps.getMainWindow,
    );
  });

  ipcMain.removeHandler(COPY_TO_CLIPBOARD_CHANNEL);
  ipcMain.handle(COPY_TO_CLIPBOARD_CHANNEL, async (_event, text: unknown) => {
    if (typeof text !== "string") return;
    clipboard.writeText(text);
  });
}
