import * as Crypto from "node:crypto";

import type { BrowserWindow, WebContents } from "electron";

import {
  backendPort,
  backendWsUrl,
  setBackendConnectionInfo,
  startBackend,
  stopBackendAndWaitForExit,
} from "./backend/backendManager";
import {
  disableDesktopTailscaleRemoteAccess,
  enableDesktopTailscaleRemoteAccess,
  getDesktopTailscaleRemoteAccessStatus,
} from "./backend/tailscaleRemoteAccess";
import {
  getComputerUsePermissionsStatus,
  getComputerUseRuntimeStatus,
  installComputerUseRuntime,
  requestComputerUsePermissions,
  runComputerUseDoctor,
} from "./backend/cuaDriver";
import { stopCuaDriverDaemon } from "./backend/cuaDriver.daemon";
import {
  makeCuaDriverLifecycle,
  requestCuaDriverPermissionsAfterHostPreflight,
} from "./backend/cuaDriver.lifecycle";
import { requestHostAccessibilityPermission } from "./backend/cuaHostPermissions";
import {
  configureAutoUpdater,
  checkForUpdates,
  downloadAvailableUpdate,
  getUpdateState,
  installDownloadedUpdate,
  updaterConfigured,
} from "./updater/autoUpdater";
import { registerIpcHandlers } from "./window/ipcHandlers";
import type { DesktopWindowRegistry } from "./window/DesktopWindowRegistry";
import type { DesktopPreferencesStore } from "./window/desktopPreferences";
import type { FloatingAssistantWindows } from "./window/floatingAssistantWindows";
import { DEFAULT_DESKTOP_BACKEND_PORT, resolveDesktopBackendPort } from "./backend/backendPort";
import { resolveDesktopMobileRemoteNetwork } from "./backend/mobileRemoteNetwork";
import type { desktopIpcChannels } from "./main.channels";
import type { resolveDesktopMainConfig } from "./main.config";
import { syncShellEnvironmentAsync } from "./backend/syncShellEnvironment";
import { getBackendStartupState } from "./backend/backendStartupState";

interface BootstrapDesktopOptions {
  readonly baseDir: string;
  readonly channels: typeof desktopIpcChannels;
  readonly cuaDriverHostBundleId: string;
  readonly desktopPreferences: DesktopPreferencesStore;
  readonly desktopRuntimeInfo: ReturnType<typeof resolveDesktopMainConfig>["desktopRuntimeInfo"];
  readonly floatingAssistantWindows: FloatingAssistantWindows;
  readonly getIsQuitting: () => boolean;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly isDevelopment: boolean;
  readonly logHeader: (message: string) => void;
  readonly makeWindow: () => BrowserWindow;
  readonly prepareForAppQuit: (reason: string) => void;
  readonly registerFloatingAssistantIpc: () => void;
  readonly resolveIconPath: (ext: "ico" | "icns" | "png") => string | null;
  readonly serverSettingsPath: string;
  readonly setIsQuitting: (value: boolean) => void;
  readonly setMainWindow: (window: BrowserWindow) => void;
  readonly windowRegistry: DesktopWindowRegistry;
}

export async function bootstrapDesktop(options: BootstrapDesktopOptions): Promise<void> {
  const {
    baseDir,
    channels,
    cuaDriverHostBundleId,
    desktopPreferences,
    desktopRuntimeInfo,
    floatingAssistantWindows,
    getIsQuitting,
    getMainWindow,
    isDevelopment,
    logHeader,
    makeWindow,
    prepareForAppQuit,
    registerFloatingAssistantIpc,
    resolveIconPath,
    serverSettingsPath,
    setIsQuitting,
    setMainWindow,
    windowRegistry,
  } = options;
  let mobileBackendBaseUrl = "";
  let localMobileBackendBaseUrl = "";
  const cuaDriverLifecycle = makeCuaDriverLifecycle({
    stopBackendAndWaitForExit,
    stopCuaDriverDaemon,
    startBackend,
  });
  const syncMobileBackendBaseUrlFromTailscaleRemoteAccess = async (): Promise<void> => {
    const status = await getDesktopTailscaleRemoteAccessStatus(backendPort);
    mobileBackendBaseUrl =
      status.serving && status.remoteBaseUrl ? status.remoteBaseUrl : localMobileBackendBaseUrl;
  };

  logHeader("bootstrap start");
  const desktopMobileRemoteNetwork = resolveDesktopMobileRemoteNetwork({
    serverSettingsPath,
    hostOverride: process.env.BIGBUD_HOST ?? process.env.T3CODE_HOST,
  });
  const port = await resolveDesktopBackendPort({
    host: desktopMobileRemoteNetwork.bindHost,
    startPort: DEFAULT_DESKTOP_BACKEND_PORT,
  });
  logHeader(
    `selected backend port via sequential scan host=${desktopMobileRemoteNetwork.bindHost} startPort=${DEFAULT_DESKTOP_BACKEND_PORT} port=${port}`,
  );
  const authToken = Crypto.randomBytes(24).toString("hex");
  const baseUrl = `ws://${formatHostForUrl(desktopMobileRemoteNetwork.clientHost)}:${port}`;
  const wsUrl = `${baseUrl}/?token=${encodeURIComponent(authToken)}`;
  mobileBackendBaseUrl = `http://${formatHostForUrl(desktopMobileRemoteNetwork.advertisedHost)}:${port}`;
  localMobileBackendBaseUrl = mobileBackendBaseUrl;
  setBackendConnectionInfo({
    port,
    authToken,
    wsUrl,
    host: desktopMobileRemoteNetwork.bindHost,
  });
  await syncMobileBackendBaseUrlFromTailscaleRemoteAccess();
  logHeader(
    `bootstrap resolved websocket endpoint baseUrl=${baseUrl} mobileBackendBaseUrl=${mobileBackendBaseUrl}`,
  );

  registerIpcHandlers({
    PICK_FOLDER_CHANNEL: channels.pickFolder,
    CONFIRM_CHANNEL: channels.confirm,
    SET_THEME_CHANNEL: channels.setTheme,
    SET_WINDOW_MATERIAL_CHANNEL: channels.setWindowMaterial,
    CONTEXT_MENU_CHANNEL: channels.contextMenu,
    OPEN_EXTERNAL_CHANNEL: channels.openExternal,
    GET_WS_URL_CHANNEL: channels.getWsUrl,
    GET_MOBILE_BACKEND_BASE_URL_CHANNEL: channels.getMobileBackendBaseUrl,
    GET_COMPUTER_USE_RUNTIME_STATUS_CHANNEL: channels.getComputerUseRuntimeStatus,
    GET_COMPUTER_USE_PERMISSIONS_STATUS_CHANNEL: channels.getComputerUsePermissionsStatus,
    REQUEST_COMPUTER_USE_PERMISSIONS_CHANNEL: channels.requestComputerUsePermissions,
    INSTALL_COMPUTER_USE_RUNTIME_CHANNEL: channels.installComputerUseRuntime,
    RUN_COMPUTER_USE_DOCTOR_CHANNEL: channels.runComputerUseDoctor,
    GET_TAILSCALE_REMOTE_ACCESS_STATUS_CHANNEL: channels.getTailscaleRemoteAccessStatus,
    ENABLE_TAILSCALE_REMOTE_ACCESS_CHANNEL: channels.enableTailscaleRemoteAccess,
    DISABLE_TAILSCALE_REMOTE_ACCESS_CHANNEL: channels.disableTailscaleRemoteAccess,
    NOTIFICATIONS_IS_SUPPORTED_CHANNEL: channels.notificationsIsSupported,
    NOTIFICATIONS_SHOW_CHANNEL: channels.notificationsShow,
    COPY_TO_CLIPBOARD_CHANNEL: channels.copyToClipboard,
    REQUEST_FILE_ACCESS_CHANNEL: channels.requestFileAccess,
    UPDATE_GET_STATE_CHANNEL: channels.updateGetState,
    UPDATE_DOWNLOAD_CHANNEL: channels.updateDownload,
    UPDATE_INSTALL_CHANNEL: channels.updateInstall,
    UPDATE_CHECK_CHANNEL: channels.updateCheck,
    BACKEND_STARTUP_STATE_CHANNEL: channels.backendStartupState,
    BACKEND_STARTUP_GET_STATE_CHANNEL: channels.backendStartupGetState,
    getMainWindow,
    isTrustedRenderer: (webContents: WebContents) => windowRegistry.isTrusted(webContents),
    getBackendWsUrl: () => backendWsUrl,
    getIsQuitting,
    getUpdateState,
    getBackendStartupState,
    isUpdaterConfigured: () => updaterConfigured,
    checkForUpdates,
    downloadAvailableUpdate,
    installDownloadedUpdate,
    resolveIconPath,
    getMobileBackendBaseUrl: () => mobileBackendBaseUrl,
    getComputerUseRuntimeStatus: () => getComputerUseRuntimeStatus(baseDir),
    getComputerUsePermissionsStatus: () => getComputerUsePermissionsStatus(baseDir),
    requestHostAccessibilityPermission,
    requestComputerUsePermissions: (hostAccessibilityTrusted) =>
      requestCuaDriverPermissionsAfterHostPreflight({
        hostAccessibilityTrusted,
        hostBundleId: cuaDriverHostBundleId,
        lifecycle: cuaDriverLifecycle,
        requestPermissions: () => requestComputerUsePermissions(baseDir),
      }),
    installComputerUseRuntime: async () => {
      const result = await installComputerUseRuntime(baseDir, cuaDriverHostBundleId);
      if (!result.ok) return result;
      await cuaDriverLifecycle.refresh();
      const status = await getComputerUseRuntimeStatus(baseDir);
      return { ok: !status.repairRequired, status };
    },
    runComputerUseDoctor: () => runComputerUseDoctor(baseDir),
    getTailscaleRemoteAccessStatus: async () => {
      const status = await getDesktopTailscaleRemoteAccessStatus(backendPort);
      mobileBackendBaseUrl =
        status.serving && status.remoteBaseUrl ? status.remoteBaseUrl : localMobileBackendBaseUrl;
      return status;
    },
    enableTailscaleRemoteAccess: async () => {
      const status = await enableDesktopTailscaleRemoteAccess(backendPort);
      mobileBackendBaseUrl =
        status.serving && status.remoteBaseUrl ? status.remoteBaseUrl : localMobileBackendBaseUrl;
      return status;
    },
    disableTailscaleRemoteAccess: async () => {
      const status = await disableDesktopTailscaleRemoteAccess(backendPort);
      mobileBackendBaseUrl = localMobileBackendBaseUrl;
      return status;
    },
  });
  registerFloatingAssistantIpc();
  logHeader("bootstrap ipc handlers registered");
  setMainWindow(makeWindow());
  logHeader("bootstrap main window created");
  if (desktopPreferences.get().floatingAssistantEnabled && desktopPreferences.get().mascotVisible) {
    await floatingAssistantWindows.ensureMascot();
    logHeader("bootstrap floating assistant created");
  }
  configureAutoUpdater({
    updateStateChannel: channels.updateState,
    runtimeInfo: desktopRuntimeInfo,
    isDevelopment,
    getIsQuitting,
    setIsQuitting,
    stopBackendAndWaitForExit,
    onBeforeQuitForUpdate: () => {
      prepareForAppQuit("before-quit-for-update");
    },
  });
  logHeader("bootstrap auto updater configured");
  logHeader("bootstrap login shell hydration started");
  await syncShellEnvironmentAsync();
  logHeader("bootstrap login shell hydration completed");
  await startBackend();
  logHeader("bootstrap backend start requested");
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
