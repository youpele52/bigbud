import * as Crypto from "node:crypto";

import { app, BrowserWindow, dialog, ipcMain } from "electron";

import {
  clearUpdatePollTimer,
  checkForUpdates,
  configureAutoUpdater,
  downloadAvailableUpdate,
  emitUpdateState,
  getUpdateState,
  installDownloadedUpdate,
  updaterConfigured,
} from "./updater/autoUpdater";
import {
  backendPort,
  backendWsUrl,
  initBackendManager,
  setBackendConnectionInfo,
  startBackend,
  stopBackend,
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
import { registerIpcHandlers } from "./window/ipcHandlers";
import {
  configureBackendStartupState,
  getBackendStartupState,
  recordBackendStartupDevelopmentDiagnostics,
  recordBackendStartupFailure,
} from "./backend/backendStartupState";
import {
  createBackendStartupDiagnostics,
  createDevelopmentBackendDiagnostics,
} from "./backend/backendStartupDiagnostics";
import {
  formatErrorMessage,
  formatErrorDiagnostics,
  initializePackagedLogging,
  type QueuedLogSink,
  resolveDesktopLogDir,
  writeDesktopLogHeader,
} from "./logging/logging";
import {
  configureApplicationMenu,
  getSafeExternalUrl,
  makeResolveIconPath,
} from "./window/menuManager";
import { syncShellEnvironmentAsync } from "./backend/syncShellEnvironment";
import { createWindow } from "./window/windowManager";
import { DEFAULT_DESKTOP_BACKEND_PORT, resolveDesktopBackendPort } from "./backend/backendPort";
import { resolveDesktopMobileRemoteNetwork } from "./backend/mobileRemoteNetwork";
import { configureAppIdentity, resolveUserDataPath } from "./main.appIdentity";
import { registerDesktopProtocol, registerDesktopSchemeAsPrivileged } from "./main.protocol";
import {
  applyLinuxRuntimeSwitches,
  installDesktopSingleInstanceLock,
  registerDesktopRuntimeMonitoring,
} from "./main.runtime";
import { desktopIpcChannels } from "./main.channels";
import { resolveDesktopMainConfig } from "./main.config";
import { DesktopWindowRegistry } from "./window/DesktopWindowRegistry";
import { DesktopPreferencesStore } from "./window/desktopPreferences";
import { FloatingAssistantWindows } from "./window/floatingAssistantWindows";

const channels = desktopIpcChannels;

const mainConfig = resolveDesktopMainConfig(app, __dirname);
const {
  appDisplayName: APP_DISPLAY_NAME,
  appUserModelId: APP_USER_MODEL_ID,
  baseDir: BASE_DIR,
  cuaDriverHostBundleId: CUA_DRIVER_HOST_BUNDLE_ID,
  desktopLinuxRuntimeConfig,
  desktopRuntimeInfo,
  desktopScheme: DESKTOP_SCHEME,
  isDevelopment,
  isDevelopmentDiagnostics,
  legacyUserDataDirName: LEGACY_USER_DATA_DIR_NAME,
  linuxDesktopEntryName: LINUX_DESKTOP_ENTRY_NAME,
  linuxGpuFallbackMarkerPath: LINUX_GPU_FALLBACK_MARKER_PATH,
  linuxWmClass: LINUX_WM_CLASS,
  rootDir: ROOT_DIR,
  serverSettingsPath: SERVER_SETTINGS_PATH,
  userDataDirName: USER_DATA_DIR_NAME,
} = mainConfig;
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_FILE_MAX_FILES = 10;
const APP_RUN_ID = Crypto.randomBytes(6).toString("hex");

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let desktopProtocolRegistered = false;
let desktopLogSink: QueuedLogSink | null = null;
let backendLogSink: QueuedLogSink | null = null;
let restoreStdIoCapture: (() => void) | null = null;
let mobileBackendBaseUrl = "";
let localMobileBackendBaseUrl = "";
const windowRegistry = new DesktopWindowRegistry();
let desktopPreferences: DesktopPreferencesStore;
let floatingAssistantWindows: FloatingAssistantWindows;
const cuaDriverLifecycle = makeCuaDriverLifecycle({
  stopBackendAndWaitForExit,
  stopCuaDriverDaemon,
  startBackend,
});

async function syncMobileBackendBaseUrlFromTailscaleRemoteAccess(): Promise<void> {
  const status = await getDesktopTailscaleRemoteAccessStatus(backendPort);
  mobileBackendBaseUrl =
    status.serving && status.remoteBaseUrl ? status.remoteBaseUrl : localMobileBackendBaseUrl;
}

// Resolved once after logging init.
const resolveIconPath = makeResolveIconPath(__dirname, process.resourcesPath ?? "", isDevelopment);
const desktopAppIdentity = {
  appDisplayName: APP_DISPLAY_NAME,
  appUserModelId: APP_USER_MODEL_ID,
  legacyUserDataDirName: LEGACY_USER_DATA_DIR_NAME,
  linuxDesktopEntryName: LINUX_DESKTOP_ENTRY_NAME,
  resolveIconPath,
  rootDir: ROOT_DIR,
  userDataDirName: USER_DATA_DIR_NAME,
} as const;

// Must happen before logging initialization so packaged crash logs follow the
// Electron user-data location (including legacy-profile migration).
app.setPath(
  "userData",
  resolveUserDataPath({
    legacyUserDataDirName: LEGACY_USER_DATA_DIR_NAME,
    userDataDirName: USER_DATA_DIR_NAME,
  }),
);
desktopPreferences = new DesktopPreferencesStore(app.getPath("userData"), logHeader);
floatingAssistantWindows = new FloatingAssistantWindows({
  desktopDir: __dirname,
  desktopScheme: DESKTOP_SCHEME,
  getSafeExternalUrl,
  isDevelopment,
  onOpenMain: () => openMainWindow(),
  onQuit: () => {
    prepareForAppQuit("floating-assistant-menu-quit");
    app.quit();
  },
  preferences: desktopPreferences,
  registry: windowRegistry,
  resolveIconPath,
  spellcheckEnabled: desktopLinuxRuntimeConfig.spellcheckEnabled,
});
const LOG_DIR = resolveDesktopLogDir(app.getPath("userData"));

// Logging convenience wrapper

function logHeader(message: string): void {
  writeDesktopLogHeader(message, desktopLogSink, APP_RUN_ID);
}

function flushDiagnosticLogs(): void {
  desktopLogSink?.flush();
  backendLogSink?.flush();
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function recordMainProcessCrash(error: unknown): void {
  const startup = getBackendStartupState();
  if (startup.generation === 0) return;
  const developmentDiagnostics = isDevelopmentDiagnostics
    ? createDevelopmentBackendDiagnostics({ error })
    : undefined;
  if (startup.status === "starting" || startup.status === "upgrading") {
    recordBackendStartupFailure(
      startup.generation,
      "unknown",
      createBackendStartupDiagnostics({ category: "runtime" }),
      developmentDiagnostics,
    );
  } else if (developmentDiagnostics) {
    recordBackendStartupDevelopmentDiagnostics(startup.generation, developmentDiagnostics);
  }
}

installDesktopSingleInstanceLock(app, () => {
  openMainWindow();
});

registerDesktopSchemeAsPrivileged(DESKTOP_SCHEME);

function handleFatalStartupError(stage: string, error: unknown): void {
  recordMainProcessCrash(error);
  const message = formatErrorMessage(error);
  const detail =
    error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
  logHeader(`fatal startup error stage=${stage} error=${formatErrorDiagnostics(error)}`);
  console.error(`[desktop] fatal startup error (${stage})`, error);
  if (!isQuitting) {
    isQuitting = true;
    dialog.showErrorBox("bigbud failed to start", `Stage: ${stage}\n${message}${detail}`);
  }
  stopBackend();
  stopCuaDriverDaemon();
  restoreStdIoCapture?.();
  flushDiagnosticLogs();
  app.quit();
}

// Packaged logging initialisation (runs synchronously at module load)

const loggingResult = initializePackagedLogging(
  LOG_DIR,
  LOG_FILE_MAX_BYTES,
  LOG_FILE_MAX_FILES,
  APP_RUN_ID,
);
desktopLogSink = loggingResult.desktopLogSink;
backendLogSink = loggingResult.backendLogSink;
restoreStdIoCapture = loggingResult.restoreStdIoCapture;

// Global safety net: pipe/connection errors from a dying backend child
// must not bring down the main process with a raw crash dialog.
process.on("uncaughtException", (error) => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ENOTCONN") {
    logHeader(`swallowed uncaught ${code}: ${formatErrorMessage(error)}`);
    console.error(`[desktop] swallowed uncaught ${code}`, error);
    return;
  }

  logHeader(`uncaughtException: ${formatErrorDiagnostics(error)}`);
  console.error("[desktop] uncaughtException", error);
  recordMainProcessCrash(error);
  if (!isQuitting) {
    isQuitting = true;
    dialog.showErrorBox("bigbud encountered an unexpected error", formatErrorMessage(error));
    stopBackend();
    stopCuaDriverDaemon();
    restoreStdIoCapture?.();
    flushDiagnosticLogs();
    app.quit();
  }
});

process.on("unhandledRejection", (reason) => {
  logHeader(`unhandledRejection: ${formatErrorDiagnostics(reason)}`);
  console.error("[desktop] unhandledRejection", reason);
});

applyLinuxRuntimeSwitches(app, LINUX_WM_CLASS, desktopLinuxRuntimeConfig);

configureAppIdentity({
  ...desktopAppIdentity,
});

// Window factory (thin wrapper that closes over main.ts state)

function makeWindow(): BrowserWindow {
  const window = createWindow({
    appDisplayName: APP_DISPLAY_NAME,
    desktopScheme: DESKTOP_SCHEME,
    isDevelopment,
    desktopDir: __dirname,
    menuActionChannel: channels.menuAction,
    spellcheckEnabled: desktopLinuxRuntimeConfig.spellcheckEnabled,
    resolveIconPath,
    getSafeExternalUrl,
    emitUpdateState,
    onWindowClosed: (w) => {
      if (mainWindow === w) mainWindow = null;
    },
  });
  windowRegistry.register("main", window);
  return window;
}

function openMainWindow(threadId?: string): BrowserWindow {
  const window = mainWindow ?? makeWindow();
  mainWindow = window;
  const show = () => {
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
    if (threadId) window.webContents.send(channels.menuAction, `open-thread:${threadId}`);
  };
  if (window.webContents.isLoadingMainFrame()) window.webContents.once("did-finish-load", show);
  else show();
  return window;
}

function registerFloatingAssistantIpc(): void {
  ipcMain.removeAllListeners(channels.getWindowRole);
  ipcMain.on(channels.getWindowRole, (event) => {
    event.returnValue = windowRegistry.getRole(event.sender);
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
    app.quit();
    return true;
  });
  register(
    channels.getFloatingAssistantEnabled,
    () => desktopPreferences.get().floatingAssistantEnabled,
  );
  register(channels.setFloatingAssistantEnabled, async (enabled) => {
    if (typeof enabled !== "boolean") return false;
    desktopPreferences.update({ floatingAssistantEnabled: enabled, mascotVisible: enabled });
    if (enabled) await floatingAssistantWindows.ensureMascot();
    else floatingAssistantWindows.disable();
    return true;
  });
}

// Bootstrap

async function bootstrap(): Promise<void> {
  logHeader("bootstrap start");
  const desktopMobileRemoteNetwork = resolveDesktopMobileRemoteNetwork({
    serverSettingsPath: SERVER_SETTINGS_PATH,
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
    getMainWindow: () => mainWindow,
    isTrustedRenderer: (webContents) => windowRegistry.isTrusted(webContents),
    getBackendWsUrl: () => backendWsUrl,
    getIsQuitting: () => isQuitting,
    getUpdateState,
    getBackendStartupState,
    isUpdaterConfigured: () => updaterConfigured,
    checkForUpdates,
    downloadAvailableUpdate,
    installDownloadedUpdate,
    resolveIconPath,
    getMobileBackendBaseUrl: () => mobileBackendBaseUrl,
    getComputerUseRuntimeStatus: () => getComputerUseRuntimeStatus(BASE_DIR),
    getComputerUsePermissionsStatus: () => getComputerUsePermissionsStatus(BASE_DIR),
    requestHostAccessibilityPermission,
    requestComputerUsePermissions: (hostAccessibilityTrusted) =>
      requestCuaDriverPermissionsAfterHostPreflight({
        hostAccessibilityTrusted,
        hostBundleId: CUA_DRIVER_HOST_BUNDLE_ID,
        lifecycle: cuaDriverLifecycle,
        requestPermissions: () => requestComputerUsePermissions(BASE_DIR),
      }),
    installComputerUseRuntime: async () => {
      const result = await installComputerUseRuntime(BASE_DIR, CUA_DRIVER_HOST_BUNDLE_ID);
      if (!result.ok) return result;
      await cuaDriverLifecycle.refresh();
      const status = await getComputerUseRuntimeStatus(BASE_DIR);
      return { ok: !status.repairRequired, status };
    },
    runComputerUseDoctor: () => runComputerUseDoctor(BASE_DIR),
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
  mainWindow = makeWindow();
  logHeader("bootstrap main window created");
  if (desktopPreferences.get().floatingAssistantEnabled) {
    await floatingAssistantWindows.ensureMascot();
    logHeader("bootstrap floating assistant created");
  }
  configureAutoUpdater({
    updateStateChannel: channels.updateState,
    runtimeInfo: desktopRuntimeInfo,
    isDevelopment,
    getIsQuitting: () => isQuitting,
    setIsQuitting: (v) => {
      isQuitting = v;
    },
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

// App event handlers

/**
 * Shared teardown path called from both `before-quit` and `before-quit-for-update`.
 * Stops the backend process, clears update poll timers, and restores stdio capture.
 * Idempotent — safe to call multiple times.
 */
function prepareForAppQuit(reason: string): void {
  if (isQuitting) return;
  isQuitting = true;
  floatingAssistantWindows.destroyForQuit();
  logHeader(`${reason} received`);
  clearUpdatePollTimer();
  stopBackend();
  stopCuaDriverDaemon();
  restoreStdIoCapture?.();
  flushDiagnosticLogs();
}

app.on("before-quit", () => {
  prepareForAppQuit("before-quit");
});

app
  .whenReady()
  .then(() => {
    logHeader("app ready");
    registerDesktopRuntimeMonitoring({
      appInstance: app,
      runtimeConfig: desktopLinuxRuntimeConfig,
      linuxGpuFallbackMarkerPath: LINUX_GPU_FALLBACK_MARKER_PATH,
      log: logHeader,
    });
    app.on("render-process-gone", (_event, _webContents, details) => {
      logHeader(`renderer process gone reason=${details.reason} exitCode=${details.exitCode}`);
    });

    initBackendManager({
      rootDir: ROOT_DIR,
      baseDir: BASE_DIR,
      backendMaxOldSpaceMb: desktopLinuxRuntimeConfig.backendMaxOldSpaceMb,
      cuaDriverHostBundleId: CUA_DRIVER_HOST_BUNDLE_ID,
      serverSettingsPath: SERVER_SETTINGS_PATH,
      getIsQuitting: () => isQuitting,
      getBackendLogSink: () => backendLogSink,
      isDevelopmentDiagnostics,
      runId: APP_RUN_ID,
    });
    configureBackendStartupState(channels.backendStartupState, isDevelopmentDiagnostics);

    configureAppIdentity(desktopAppIdentity);
    desktopProtocolRegistered = registerDesktopProtocol({
      desktopScheme: DESKTOP_SCHEME,
      isDevelopment,
      isRegistered: desktopProtocolRegistered,
      rootDir: ROOT_DIR,
    });
    configureApplicationMenu({
      menuActionChannel: channels.menuAction,
      getMainWindow: () => mainWindow,
      setMainWindow: (w) => {
        mainWindow = w;
      },
      makeWindow,
      checkForUpdates,
      getUpdateState,
      isDevelopment,
    });
    void bootstrap().catch((error) => {
      handleFatalStartupError("bootstrap", error);
    });

    app.on("activate", () => {
      openMainWindow();
    });
  })
  .catch((error) => {
    handleFatalStartupError("whenReady", error);
  });

app.on("window-all-closed", () => {
  if (
    process.platform !== "darwin" &&
    !isQuitting &&
    !desktopPreferences.get().floatingAssistantEnabled
  ) {
    app.quit();
  }
});

if (process.platform !== "win32") {
  process.on("SIGINT", () => {
    prepareForAppQuit("SIGINT");
    app.quit();
  });

  process.on("SIGTERM", () => {
    prepareForAppQuit("SIGTERM");
    app.quit();
  });
}
