import * as Crypto from "node:crypto";

import { app, BrowserWindow, dialog } from "electron";

import {
  clearUpdatePollTimer,
  checkForUpdates,
  emitUpdateState,
  getUpdateState,
} from "./updater/autoUpdater";
import { initBackendManager, stopBackend } from "./backend/backendManager";
import { stopCuaDriverDaemon } from "./backend/cuaDriver.daemon";
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
import { createWindow } from "./window/windowManager";
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
import { bootstrapDesktop } from "./main.bootstrap";
import { registerFloatingAssistantIpc } from "./main.floatingAssistant";

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
const windowRegistry = new DesktopWindowRegistry();
let desktopPreferences: DesktopPreferencesStore;
let floatingAssistantWindows: FloatingAssistantWindows;

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
    void bootstrapDesktop({
      baseDir: BASE_DIR,
      channels,
      cuaDriverHostBundleId: CUA_DRIVER_HOST_BUNDLE_ID,
      desktopPreferences,
      desktopRuntimeInfo,
      floatingAssistantWindows,
      getIsQuitting: () => isQuitting,
      getMainWindow: () => mainWindow,
      isDevelopment,
      logHeader,
      makeWindow,
      prepareForAppQuit,
      registerFloatingAssistantIpc: () =>
        registerFloatingAssistantIpc({
          appInstance: app,
          channels,
          desktopPreferences,
          floatingAssistantWindows,
          openMainWindow,
          prepareForAppQuit,
          windowRegistry,
        }),
      resolveIconPath,
      serverSettingsPath: SERVER_SETTINGS_PATH,
      setIsQuitting: (value) => {
        isQuitting = value;
      },
      setMainWindow: (window) => {
        mainWindow = window;
      },
      windowRegistry,
    }).catch((error) => {
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
