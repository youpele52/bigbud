import { BrowserWindow, clipboard, dialog, nativeTheme, shell } from "electron";

import { authorizedHandle, authorizedOn, BROAD_RENDERER_ROLES } from "./ipcAuthorization";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  DesktopTailscaleRemoteAccessStatus,
  DesktopTheme,
  DesktopUpdateActionResult,
  DesktopUpdateCheckResult,
  DesktopUpdateState,
} from "@bigbud/contracts";
import type { DesktopBackendStartupState } from "@bigbud/contracts/server/ipc.desktop.ts";
import { showDesktopConfirmDialog } from "./confirmDialog";
import {
  isDesktopNotificationSupported,
  showDesktopNotification,
} from "./ipcHandlers.notifications";
import { getSafeExternalUrl } from "./menuManager";
import {
  registerComputerUseIpcHandlers,
  type ComputerUseIpcHandlerDeps,
} from "./ipcHandlers.computerUse";
import { applyWindowMaterial, getSafeWindowMaterial } from "./windowManager";
import { registerCertificateChallengeHandlers } from "./ipcHandlers.certificateChallenge";
import { registerContextMenuIpcHandler } from "./ipcHandlers.contextMenu";

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

// ---------------------------------------------------------------------------
// IPC handler registration
// ---------------------------------------------------------------------------

export interface IpcHandlerDeps extends ComputerUseIpcHandlerDeps {
  // Channel names
  readonly PICK_FOLDER_CHANNEL: string;
  readonly CONFIRM_CHANNEL: string;
  readonly SET_THEME_CHANNEL: string;
  readonly SET_WINDOW_MATERIAL_CHANNEL: string;
  readonly CONTEXT_MENU_CHANNEL: string;
  readonly OPEN_EXTERNAL_CHANNEL: string;
  readonly GET_WS_URL_CHANNEL: string;
  readonly GET_MOBILE_BACKEND_BASE_URL_CHANNEL: string;
  readonly GET_TAILSCALE_REMOTE_ACCESS_STATUS_CHANNEL: string;
  readonly ENABLE_TAILSCALE_REMOTE_ACCESS_CHANNEL: string;
  readonly DISABLE_TAILSCALE_REMOTE_ACCESS_CHANNEL: string;
  readonly NOTIFICATIONS_IS_SUPPORTED_CHANNEL: string;
  readonly NOTIFICATIONS_SHOW_CHANNEL: string;
  readonly COPY_TO_CLIPBOARD_CHANNEL: string;
  readonly REQUEST_FILE_ACCESS_CHANNEL: string;
  readonly UPDATE_GET_STATE_CHANNEL: string;
  readonly UPDATE_DOWNLOAD_CHANNEL: string;
  readonly UPDATE_INSTALL_CHANNEL: string;
  readonly UPDATE_CHECK_CHANNEL: string;
  readonly BACKEND_STARTUP_GET_STATE_CHANNEL: string;
  readonly BACKEND_STARTUP_STATE_CHANNEL: string;

  // State/action accessors
  readonly getMainWindow: () => BrowserWindow | null;
  readonly openMainWindow: (threadId?: string) => BrowserWindow;
  readonly isTrustedRenderer?: (webContents: Electron.WebContents) => boolean;
  readonly getBackendWsUrl: () => string;
  readonly getMobileBackendBaseUrl: () => string;
  readonly getTailscaleRemoteAccessStatus: () => Promise<DesktopTailscaleRemoteAccessStatus>;
  readonly enableTailscaleRemoteAccess: () => Promise<DesktopTailscaleRemoteAccessStatus>;
  readonly disableTailscaleRemoteAccess: () => Promise<DesktopTailscaleRemoteAccessStatus>;
  readonly getIsQuitting: () => boolean;
  readonly getUpdateState: () => DesktopUpdateState;
  readonly getBackendStartupState: () => DesktopBackendStartupState;
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
    SET_WINDOW_MATERIAL_CHANNEL,
    CONTEXT_MENU_CHANNEL,
    OPEN_EXTERNAL_CHANNEL,
    GET_WS_URL_CHANNEL,
    GET_MOBILE_BACKEND_BASE_URL_CHANNEL,
    GET_COMPUTER_USE_RUNTIME_STATUS_CHANNEL,
    GET_COMPUTER_USE_PERMISSIONS_STATUS_CHANNEL,
    REQUEST_COMPUTER_USE_PERMISSIONS_CHANNEL,
    INSTALL_COMPUTER_USE_RUNTIME_CHANNEL,
    RUN_COMPUTER_USE_DOCTOR_CHANNEL,
    GET_TAILSCALE_REMOTE_ACCESS_STATUS_CHANNEL,
    ENABLE_TAILSCALE_REMOTE_ACCESS_CHANNEL,
    DISABLE_TAILSCALE_REMOTE_ACCESS_CHANNEL,
    NOTIFICATIONS_IS_SUPPORTED_CHANNEL,
    NOTIFICATIONS_SHOW_CHANNEL,
    COPY_TO_CLIPBOARD_CHANNEL,
    REQUEST_FILE_ACCESS_CHANNEL,
    UPDATE_GET_STATE_CHANNEL,
    UPDATE_DOWNLOAD_CHANNEL,
    UPDATE_INSTALL_CHANNEL,
    UPDATE_CHECK_CHANNEL,
    BACKEND_STARTUP_GET_STATE_CHANNEL,
  } = deps;

  authorizedHandle(BACKEND_STARTUP_GET_STATE_CHANNEL, BROAD_RENDERER_ROLES, (event) => {
    if (
      !deps.isTrustedRenderer?.(event.sender) &&
      event.sender !== deps.getMainWindow()?.webContents
    ) {
      throw new Error("Backend startup state is only available to trusted desktop renderers.");
    }
    return deps.getBackendStartupState();
  });

  authorizedOn(GET_WS_URL_CHANNEL, BROAD_RENDERER_ROLES, (event) => {
    event.returnValue = deps.getBackendWsUrl();
  });

  authorizedOn(GET_MOBILE_BACKEND_BASE_URL_CHANNEL, BROAD_RENDERER_ROLES, (event) => {
    event.returnValue = deps.getMobileBackendBaseUrl();
  });

  registerComputerUseIpcHandlers({
    GET_COMPUTER_USE_RUNTIME_STATUS_CHANNEL,
    GET_COMPUTER_USE_PERMISSIONS_STATUS_CHANNEL,
    REQUEST_COMPUTER_USE_PERMISSIONS_CHANNEL,
    INSTALL_COMPUTER_USE_RUNTIME_CHANNEL,
    RUN_COMPUTER_USE_DOCTOR_CHANNEL,
    getComputerUseRuntimeStatus: deps.getComputerUseRuntimeStatus,
    getComputerUsePermissionsStatus: deps.getComputerUsePermissionsStatus,
    requestHostAccessibilityPermission: deps.requestHostAccessibilityPermission,
    requestComputerUsePermissions: deps.requestComputerUsePermissions,
    installComputerUseRuntime: deps.installComputerUseRuntime,
    runComputerUseDoctor: deps.runComputerUseDoctor,
  });
  registerCertificateChallengeHandlers();

  authorizedHandle(GET_TAILSCALE_REMOTE_ACCESS_STATUS_CHANNEL, BROAD_RENDERER_ROLES, () =>
    deps.getTailscaleRemoteAccessStatus(),
  );

  authorizedHandle(ENABLE_TAILSCALE_REMOTE_ACCESS_CHANNEL, BROAD_RENDERER_ROLES, () =>
    deps.enableTailscaleRemoteAccess(),
  );

  authorizedHandle(DISABLE_TAILSCALE_REMOTE_ACCESS_CHANNEL, BROAD_RENDERER_ROLES, () =>
    deps.disableTailscaleRemoteAccess(),
  );

  authorizedHandle(PICK_FOLDER_CHANNEL, BROAD_RENDERER_ROLES, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? deps.getMainWindow();
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

  authorizedHandle(CONFIRM_CHANNEL, BROAD_RENDERER_ROLES, async (event, message: unknown) => {
    if (typeof message !== "string") {
      return false;
    }

    const owner = BrowserWindow.fromWebContents(event.sender) ?? deps.getMainWindow();
    return showDesktopConfirmDialog(message, owner);
  });

  authorizedHandle(SET_THEME_CHANNEL, BROAD_RENDERER_ROLES, async (_event, rawTheme: unknown) => {
    const theme = getSafeTheme(rawTheme);
    if (!theme) {
      return;
    }

    nativeTheme.themeSource = theme;
  });

  authorizedHandle(
    SET_WINDOW_MATERIAL_CHANNEL,
    BROAD_RENDERER_ROLES,
    async (event, rawWindowMaterial: unknown) => {
      const windowMaterial = getSafeWindowMaterial(rawWindowMaterial);
      if (!windowMaterial) {
        return;
      }

      const window = BrowserWindow.fromWebContents(event.sender) ?? deps.getMainWindow();
      if (!window) {
        return;
      }

      applyWindowMaterial(window, windowMaterial);
    },
  );

  registerContextMenuIpcHandler(CONTEXT_MENU_CHANNEL, deps.getMainWindow);

  authorizedHandle(OPEN_EXTERNAL_CHANNEL, BROAD_RENDERER_ROLES, async (_event, rawUrl: unknown) => {
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

  authorizedHandle(UPDATE_GET_STATE_CHANNEL, BROAD_RENDERER_ROLES, async () =>
    deps.getUpdateState(),
  );

  authorizedHandle(UPDATE_DOWNLOAD_CHANNEL, BROAD_RENDERER_ROLES, async () => {
    const result = await deps.downloadAvailableUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: deps.getUpdateState(),
    } satisfies DesktopUpdateActionResult;
  });

  authorizedHandle(UPDATE_INSTALL_CHANNEL, BROAD_RENDERER_ROLES, async () => {
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

  authorizedHandle(UPDATE_CHECK_CHANNEL, BROAD_RENDERER_ROLES, async () => {
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

  authorizedHandle(NOTIFICATIONS_IS_SUPPORTED_CHANNEL, BROAD_RENDERER_ROLES, () =>
    isDesktopNotificationSupported(),
  );

  authorizedHandle(NOTIFICATIONS_SHOW_CHANNEL, BROAD_RENDERER_ROLES, (_event, input: unknown) => {
    if (typeof input !== "object" || input === null) {
      return false;
    }
    const { title, body, silent, threadId } = input as Record<string, unknown>;
    return showDesktopNotification(
      {
        title: typeof title === "string" ? title : "",
        ...(typeof body === "string" ? { body } : {}),
        ...(silent === true ? { silent: true } : {}),
        ...(typeof threadId === "string" && threadId.trim().length > 0
          ? { threadId: threadId.trim() }
          : {}),
      },
      deps.resolveIconPath,
      deps.getMainWindow,
      deps.openMainWindow,
    );
  });

  authorizedHandle(
    COPY_TO_CLIPBOARD_CHANNEL,
    BROAD_RENDERER_ROLES,
    async (_event, text: unknown) => {
      if (typeof text !== "string") return;
      clipboard.writeText(text);
    },
  );

  authorizedHandle(
    REQUEST_FILE_ACCESS_CHANNEL,
    BROAD_RENDERER_ROLES,
    async (_event, level: unknown) => {
      const home = os.homedir();
      const folders =
        level === "unrestricted"
          ? ["/", "/Users", home]
          : level === "common-folders"
            ? ["Desktop", "Documents", "Downloads", "Music", "Pictures"].map((f) =>
                path.join(home, f),
              )
            : [];

      const granted: string[] = [];
      const denied: string[] = [];

      for (const folder of folders) {
        try {
          fs.accessSync(folder, fs.constants.R_OK);
          granted.push(folder);
        } catch {
          denied.push(folder);
        }
      }

      return {
        success: granted.length > 0,
        granted,
        denied,
      };
    },
  );
}
