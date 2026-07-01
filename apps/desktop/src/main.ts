import * as Crypto from "node:crypto";
import * as OS from "node:os";
import * as Path from "node:path";

import { app, BrowserWindow, dialog } from "electron";

import type { RotatingFileSink } from "@bigbud/shared/logging";
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
import { registerIpcHandlers } from "./window/ipcHandlers";
import {
  formatErrorMessage,
  initializePackagedLogging,
  writeDesktopLogHeader,
} from "./logging/logging";
import {
  configureApplicationMenu,
  getSafeExternalUrl,
  makeResolveIconPath,
} from "./window/menuManager";
import { resolveDesktopRuntimeInfo } from "./env/runtimeArch";
import { syncShellEnvironmentAsync } from "./backend/syncShellEnvironment";
import { createWindow } from "./window/windowManager";
import { DEFAULT_DESKTOP_BACKEND_PORT, resolveDesktopBackendPort } from "./backend/backendPort";
import { resolveDesktopMobileRemoteNetwork } from "./backend/mobileRemoteNetwork";
import { configureAppIdentity, resolveUserDataPath } from "./main.appIdentity";
import {
  readLinuxGpuFallbackMarker,
  resolveLinuxDesktopRuntimeConfig,
  resolveLinuxGpuFallbackMarkerPath,
} from "./main.linuxRuntime";
import { registerDesktopProtocol, registerDesktopSchemeAsPrivileged } from "./main.protocol";
import {
  applyLinuxRuntimeSwitches,
  installDesktopSingleInstanceLock,
  registerDesktopRuntimeMonitoring,
} from "./main.runtime";

// ---------------------------------------------------------------------------
// IPC channel names (kept in main.ts per spec)
// ---------------------------------------------------------------------------

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const SET_THEME_CHANNEL = "desktop:set-theme";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const UPDATE_CHECK_CHANNEL = "desktop:update-check";
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_DIR =
  process.env.BIGBUD_HOME?.trim() ||
  process.env.T3CODE_HOME?.trim() ||
  Path.join(OS.homedir(), ".bigbud");
const STATE_DIR = Path.join(BASE_DIR, "userdata");
const DESKTOP_SCHEME = "bigbud";
const ROOT_DIR = Path.resolve(__dirname, "../../..");
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const APP_DISPLAY_NAME = isDevelopment ? "bigbud (Dev)" : "bigbud (Beta)";
const APP_USER_MODEL_ID = "ai.bigbud.desktop";
const LINUX_DESKTOP_ENTRY_NAME = isDevelopment ? "bigbud-dev.desktop" : "bigbud.desktop";
const LINUX_WM_CLASS = isDevelopment ? "bigbud-dev" : "bigbud";
const USER_DATA_DIR_NAME = isDevelopment ? "bigbud-dev" : "bigbud";
// Intentionally keep the legacy Alpha-era directory name here so packaged users
// from older T3 Code builds continue to migrate their existing desktop data.
// Remove this once the legacy Alpha-to-Beta upgrade window is no longer needed.
const LEGACY_USER_DATA_DIR_NAME = isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)";
const LOG_DIR = Path.join(STATE_DIR, "logs");
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_FILE_MAX_FILES = 10;
const APP_RUN_ID = Crypto.randomBytes(6).toString("hex");
const SERVER_SETTINGS_PATH = Path.join(STATE_DIR, "settings.json");
const LINUX_GPU_FALLBACK_MARKER_PATH = resolveLinuxGpuFallbackMarkerPath(STATE_DIR);

// ---------------------------------------------------------------------------
// App-lifecycle state
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let desktopProtocolRegistered = false;
let desktopLogSink: RotatingFileSink | null = null;
let backendLogSink: RotatingFileSink | null = null;
let restoreStdIoCapture: (() => void) | null = null;
let mobileBackendBaseUrl = "";
let localMobileBackendBaseUrl = "";

async function syncMobileBackendBaseUrlFromTailscaleRemoteAccess(): Promise<void> {
  const status = await getDesktopTailscaleRemoteAccessStatus(backendPort);
  mobileBackendBaseUrl =
    status.serving && status.remoteBaseUrl ? status.remoteBaseUrl : localMobileBackendBaseUrl;
}

const desktopRuntimeInfo = resolveDesktopRuntimeInfo({
  platform: process.platform,
  processArch: process.arch,
  runningUnderArm64Translation: app.runningUnderARM64Translation === true,
});
const desktopLinuxRuntimeConfig = resolveLinuxDesktopRuntimeConfig({
  gpuFallbackMarkerArmed: readLinuxGpuFallbackMarker(LINUX_GPU_FALLBACK_MARKER_PATH),
});

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

// ---------------------------------------------------------------------------
// Logging convenience wrapper
// ---------------------------------------------------------------------------

function logHeader(message: string): void {
  writeDesktopLogHeader(message, desktopLogSink, APP_RUN_ID);
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

installDesktopSingleInstanceLock(app, () => mainWindow);

registerDesktopSchemeAsPrivileged(DESKTOP_SCHEME);

function handleFatalStartupError(stage: string, error: unknown): void {
  const message = formatErrorMessage(error);
  const detail =
    error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
  logHeader(`fatal startup error stage=${stage} message=${message}`);
  console.error(`[desktop] fatal startup error (${stage})`, error);
  if (!isQuitting) {
    isQuitting = true;
    dialog.showErrorBox("bigbud failed to start", `Stage: ${stage}\n${message}${detail}`);
  }
  stopBackend();
  restoreStdIoCapture?.();
  app.quit();
}

// ---------------------------------------------------------------------------
// Packaged logging initialisation (runs synchronously at module load)
// ---------------------------------------------------------------------------

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

  logHeader(`uncaughtException: ${formatErrorMessage(error)}`);
  console.error("[desktop] uncaughtException", error);
  if (!isQuitting) {
    isQuitting = true;
    dialog.showErrorBox("bigbud encountered an unexpected error", formatErrorMessage(error));
    stopBackend();
    restoreStdIoCapture?.();
    app.quit();
  }
});

process.on("unhandledRejection", (reason) => {
  logHeader(`unhandledRejection: ${formatErrorMessage(reason)}`);
  console.error("[desktop] unhandledRejection", reason);
});

applyLinuxRuntimeSwitches(app, LINUX_WM_CLASS, desktopLinuxRuntimeConfig);

// Override Electron's userData path before the `ready` event so that
// Chromium session data uses a filesystem-friendly directory name.
// Must be called synchronously at the top level — before `app.whenReady()`.
app.setPath(
  "userData",
  resolveUserDataPath({
    legacyUserDataDirName: LEGACY_USER_DATA_DIR_NAME,
    userDataDirName: USER_DATA_DIR_NAME,
  }),
);

configureAppIdentity({
  ...desktopAppIdentity,
});

// ---------------------------------------------------------------------------
// Window factory (thin wrapper that closes over main.ts state)
// ---------------------------------------------------------------------------

function makeWindow(): BrowserWindow {
  return createWindow({
    appDisplayName: APP_DISPLAY_NAME,
    desktopScheme: DESKTOP_SCHEME,
    isDevelopment,
    desktopDir: __dirname,
    spellcheckEnabled: desktopLinuxRuntimeConfig.spellcheckEnabled,
    resolveIconPath,
    getSafeExternalUrl,
    emitUpdateState,
    onWindowClosed: (w) => {
      if (mainWindow === w) mainWindow = null;
    },
  });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

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
    PICK_FOLDER_CHANNEL,
    CONFIRM_CHANNEL,
    SET_THEME_CHANNEL,
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
    getMainWindow: () => mainWindow,
    getBackendWsUrl: () => backendWsUrl,
    getIsQuitting: () => isQuitting,
    getUpdateState,
    isUpdaterConfigured: () => updaterConfigured,
    checkForUpdates,
    downloadAvailableUpdate,
    installDownloadedUpdate,
    resolveIconPath,
    getMobileBackendBaseUrl: () => mobileBackendBaseUrl,
    getComputerUseRuntimeStatus: () => getComputerUseRuntimeStatus(BASE_DIR),
    getComputerUsePermissionsStatus: () => getComputerUsePermissionsStatus(BASE_DIR),
    requestComputerUsePermissions: () => requestComputerUsePermissions(BASE_DIR),
    installComputerUseRuntime: () => installComputerUseRuntime(BASE_DIR),
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
  logHeader("bootstrap ipc handlers registered");
  mainWindow = makeWindow();
  logHeader("bootstrap main window created");
  configureAutoUpdater({
    updateStateChannel: UPDATE_STATE_CHANNEL,
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
  startBackend();
  logHeader("bootstrap backend start requested");
}

// ---------------------------------------------------------------------------
// App event handlers
// ---------------------------------------------------------------------------

/**
 * Shared teardown path called from both `before-quit` and `before-quit-for-update`.
 * Stops the backend process, clears update poll timers, and restores stdio capture.
 * Idempotent — safe to call multiple times.
 */
function prepareForAppQuit(reason: string): void {
  if (isQuitting) return;
  isQuitting = true;
  logHeader(`${reason} received`);
  clearUpdatePollTimer();
  stopBackend();
  restoreStdIoCapture?.();
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

    initBackendManager({
      rootDir: ROOT_DIR,
      baseDir: BASE_DIR,
      backendMaxOldSpaceMb: desktopLinuxRuntimeConfig.backendMaxOldSpaceMb,
      serverSettingsPath: SERVER_SETTINGS_PATH,
      getIsQuitting: () => isQuitting,
      getBackendLogSink: () => backendLogSink,
      runId: APP_RUN_ID,
    });

    configureAppIdentity(desktopAppIdentity);
    desktopProtocolRegistered = registerDesktopProtocol({
      desktopScheme: DESKTOP_SCHEME,
      isDevelopment,
      isRegistered: desktopProtocolRegistered,
      rootDir: ROOT_DIR,
    });
    configureApplicationMenu({
      menuActionChannel: MENU_ACTION_CHANNEL,
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
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = makeWindow();
      }
    });
  })
  .catch((error) => {
    handleFatalStartupError("whenReady", error);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !isQuitting) {
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
