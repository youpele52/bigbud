import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopBridge } from "@bigbud/contracts";
import type { DesktopCertificateChallengeEvent } from "@bigbud/contracts/server/ipc.desktopCertificate.ts";
import { isBackendStartupState } from "./backend/backendStartupDiagnostics.validation";
import {
  CERTIFICATE_CHALLENGE_EVENT_CHANNEL,
  RESOLVE_CERTIFICATE_CHALLENGE_CHANNEL,
} from "./window/certificateChallenge.channels";

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const SET_THEME_CHANNEL = "desktop:set-theme";
const SET_WINDOW_MATERIAL_CHANNEL = "desktop:set-window-material";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_CHECK_CHANNEL = "desktop:update-check";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const GET_WS_URL_CHANNEL = "desktop:get-ws-url";
const GET_MOBILE_BACKEND_BASE_URL_CHANNEL = "desktop:get-mobile-backend-base-url";
const GET_COMPUTER_USE_RUNTIME_STATUS_CHANNEL = "desktop:get-computer-use-runtime-status";
const GET_COMPUTER_USE_PERMISSIONS_STATUS_CHANNEL = "desktop:get-computer-use-permissions-status";
const REQUEST_COMPUTER_USE_PERMISSIONS_CHANNEL = "desktop:request-computer-use-permissions";
const INSTALL_COMPUTER_USE_RUNTIME_CHANNEL = "desktop:install-computer-use-runtime";
const RUN_COMPUTER_USE_DOCTOR_CHANNEL = "desktop:run-computer-use-doctor";
const GET_TAILSCALE_REMOTE_ACCESS_STATUS_CHANNEL = "desktop:get-tailscale-remote-access-status";
const ENABLE_TAILSCALE_REMOTE_ACCESS_CHANNEL = "desktop:enable-tailscale-remote-access";
const DISABLE_TAILSCALE_REMOTE_ACCESS_CHANNEL = "desktop:disable-tailscale-remote-access";
const NOTIFICATIONS_IS_SUPPORTED_CHANNEL = "desktop:notifications-is-supported";
const NOTIFICATIONS_SHOW_CHANNEL = "desktop:notifications-show";
const COPY_TO_CLIPBOARD_CHANNEL = "desktop:copy-to-clipboard";
const REQUEST_FILE_ACCESS_CHANNEL = "desktop:request-file-access";
const BACKEND_STARTUP_STATE_CHANNEL = "desktop:backend-startup-state";
const BACKEND_STARTUP_GET_STATE_CHANNEL = "desktop:backend-startup-get-state";
const GET_WINDOW_ROLE_CHANNEL = "desktop:get-window-role";
const OPEN_MAIN_WINDOW_CHANNEL = "desktop:open-main-window";
const OPEN_COMPACT_CHAT_CHANNEL = "desktop:open-compact-chat";
const BEGIN_MASCOT_DRAG_CHANNEL = "desktop:begin-mascot-drag";
const MOVE_MASCOT_CHANNEL = "desktop:move-mascot";
const HIDE_COMPACT_CHAT_CHANNEL = "desktop:hide-compact-chat";
const HIDE_MASCOT_CHANNEL = "desktop:hide-mascot";
const DISABLE_FLOATING_ASSISTANT_CHANNEL = "desktop:disable-floating-assistant";
const QUIT_APPLICATION_CHANNEL = "desktop:quit-application";
const GET_FLOATING_ASSISTANT_ENABLED_CHANNEL = "desktop:get-floating-assistant-enabled";
const SET_FLOATING_ASSISTANT_ENABLED_CHANNEL = "desktop:set-floating-assistant-enabled";
const GET_FLOATING_ASSISTANT_CALLER_CHANNEL = "desktop:get-floating-assistant-caller";
const SET_FLOATING_ASSISTANT_CALLER_CHANNEL = "desktop:set-floating-assistant-caller";
const FLOATING_ASSISTANT_CALLER_CHANGED_CHANNEL = "desktop:floating-assistant-caller-changed";
const emptyBackendStartupState = { generation: 0, startedAt: 0, status: "idle" } as const;
// This is evaluated inside the isolated preload, not supplied by the renderer.
const allowDevelopmentDiagnostics = process.defaultApp === true;

contextBridge.exposeInMainWorld("desktopBridge", {
  getWindowRole: () => {
    const result = ipcRenderer.sendSync(GET_WINDOW_ROLE_CHANNEL);
    return result === "main" || result === "mascot" || result === "compact-chat" ? result : null;
  },
  openMainWindow: (threadId) => ipcRenderer.invoke(OPEN_MAIN_WINDOW_CHANNEL, threadId),
  openCompactChat: () => ipcRenderer.invoke(OPEN_COMPACT_CHAT_CHANNEL),
  beginMascotDrag: (point) => ipcRenderer.invoke(BEGIN_MASCOT_DRAG_CHANNEL, point),
  moveMascot: (point) => ipcRenderer.invoke(MOVE_MASCOT_CHANNEL, point),
  hideCompactChat: () => ipcRenderer.invoke(HIDE_COMPACT_CHAT_CHANNEL),
  hideMascot: () => ipcRenderer.invoke(HIDE_MASCOT_CHANNEL),
  disableFloatingAssistant: () => ipcRenderer.invoke(DISABLE_FLOATING_ASSISTANT_CHANNEL),
  quitApplication: () => ipcRenderer.invoke(QUIT_APPLICATION_CHANNEL),
  getFloatingAssistantEnabled: () => ipcRenderer.invoke(GET_FLOATING_ASSISTANT_ENABLED_CHANNEL),
  setFloatingAssistantEnabled: (enabled) =>
    ipcRenderer.invoke(SET_FLOATING_ASSISTANT_ENABLED_CHANNEL, enabled),
  getFloatingAssistantCaller: () => ipcRenderer.invoke(GET_FLOATING_ASSISTANT_CALLER_CHANNEL),
  setFloatingAssistantCaller: (caller) =>
    ipcRenderer.invoke(SET_FLOATING_ASSISTANT_CALLER_CHANNEL, caller),
  onFloatingAssistantCallerChange: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, caller: unknown) => {
      if (caller === "chrome" || caller === "logo" || caller === "matte") listener(caller);
    };
    ipcRenderer.on(FLOATING_ASSISTANT_CALLER_CHANGED_CHANNEL, wrappedListener);
    return () =>
      ipcRenderer.removeListener(FLOATING_ASSISTANT_CALLER_CHANGED_CHANNEL, wrappedListener);
  },
  getWsUrl: () => {
    const result = ipcRenderer.sendSync(GET_WS_URL_CHANNEL);
    return typeof result === "string" ? result : null;
  },
  getMobileBackendBaseUrl: () => {
    const result = ipcRenderer.sendSync(GET_MOBILE_BACKEND_BASE_URL_CHANNEL);
    return typeof result === "string" ? result : null;
  },
  getBackendStartupState: () =>
    ipcRenderer
      .invoke(BACKEND_STARTUP_GET_STATE_CHANNEL)
      .then((state: unknown) =>
        isBackendStartupState(state, allowDevelopmentDiagnostics)
          ? state
          : emptyBackendStartupState,
      ),
  onBackendStartupState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (isBackendStartupState(state, allowDevelopmentDiagnostics)) listener(state);
    };
    ipcRenderer.on(BACKEND_STARTUP_STATE_CHANNEL, wrappedListener);
    return () => ipcRenderer.removeListener(BACKEND_STARTUP_STATE_CHANNEL, wrappedListener);
  },
  getComputerUseRuntimeStatus: () => ipcRenderer.invoke(GET_COMPUTER_USE_RUNTIME_STATUS_CHANNEL),
  getComputerUsePermissionsStatus: () =>
    ipcRenderer.invoke(GET_COMPUTER_USE_PERMISSIONS_STATUS_CHANNEL),
  requestComputerUsePermissions: () => ipcRenderer.invoke(REQUEST_COMPUTER_USE_PERMISSIONS_CHANNEL),
  installComputerUseRuntime: () => ipcRenderer.invoke(INSTALL_COMPUTER_USE_RUNTIME_CHANNEL),
  runComputerUseDoctor: () => ipcRenderer.invoke(RUN_COMPUTER_USE_DOCTOR_CHANNEL),
  getTailscaleRemoteAccessStatus: () =>
    ipcRenderer.invoke(GET_TAILSCALE_REMOTE_ACCESS_STATUS_CHANNEL),
  enableTailscaleRemoteAccess: () => ipcRenderer.invoke(ENABLE_TAILSCALE_REMOTE_ACCESS_CHANNEL),
  disableTailscaleRemoteAccess: () => ipcRenderer.invoke(DISABLE_TAILSCALE_REMOTE_ACCESS_CHANNEL),
  getFilePath: (file: File) => webUtils.getPathForFile(file),
  pickFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL),
  confirm: (message) => ipcRenderer.invoke(CONFIRM_CHANNEL, message),
  onCertificateChallenge: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (typeof value !== "object" || value === null) return;
      listener(value as DesktopCertificateChallengeEvent);
    };
    ipcRenderer.on(CERTIFICATE_CHALLENGE_EVENT_CHANNEL, wrappedListener);
    return () => ipcRenderer.removeListener(CERTIFICATE_CHALLENGE_EVENT_CHANNEL, wrappedListener);
  },
  resolveCertificateChallenge: (resolution) =>
    ipcRenderer.invoke(RESOLVE_CERTIFICATE_CHALLENGE_CHANNEL, resolution),
  setTheme: (theme) => ipcRenderer.invoke(SET_THEME_CHANNEL, theme),
  setWindowMaterial: (windowMaterial) =>
    ipcRenderer.invoke(SET_WINDOW_MATERIAL_CHANNEL, windowMaterial),
  showContextMenu: (items, position) => ipcRenderer.invoke(CONTEXT_MENU_CHANNEL, items, position),
  openExternal: (url: string) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
  onMenuAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      listener(action);
    };

    ipcRenderer.on(MENU_ACTION_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(MENU_ACTION_CHANNEL, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL),
  checkForUpdate: () => ipcRenderer.invoke(UPDATE_CHECK_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL),
  installUpdate: () => ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL),
  onUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(UPDATE_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, wrappedListener);
    };
  },
  notifications: {
    isSupported: () => ipcRenderer.invoke(NOTIFICATIONS_IS_SUPPORTED_CHANNEL) as Promise<boolean>,
    show: (input) => ipcRenderer.invoke(NOTIFICATIONS_SHOW_CHANNEL, input) as Promise<boolean>,
  },
  copyToClipboard: (text: string) => ipcRenderer.invoke(COPY_TO_CLIPBOARD_CHANNEL, text),
  requestFileAccess: (level) => ipcRenderer.invoke(REQUEST_FILE_ACCESS_CHANNEL, level),
} satisfies DesktopBridge);
