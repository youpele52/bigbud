import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { app, BrowserWindow, dialog, protocol } from "electron";

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
  backendWsUrl,
  initBackendManager,
  setBackendConnectionInfo,
  startBackend,
  stopBackend,
  stopBackendAndWaitForExit,
} from "./backend/backendManager";
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
import {
  isStaticAssetRequest,
  resolveAboutCommitHash,
  resolveDesktopStaticDir,
  resolveDesktopStaticPath,
} from "./env/pathResolver";
import { resolveDesktopRuntimeInfo } from "./env/runtimeArch";
import { syncShellEnvironment } from "./backend/syncShellEnvironment";
import { createWindow } from "./window/windowManager";
import { DEFAULT_DESKTOP_BACKEND_PORT, resolveDesktopBackendPort } from "./backend/backendPort";

syncShellEnvironment();

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
const NOTIFICATIONS_IS_SUPPORTED_CHANNEL = "desktop:notifications-is-supported";
const NOTIFICATIONS_SHOW_CHANNEL = "desktop:notifications-show";
const COPY_TO_CLIPBOARD_CHANNEL = "desktop:copy-to-clipboard";

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
const APP_DISPLAY_NAME = isDevelopment ? "bigbud (Dev)" : "bigbud (Alpha)";
const APP_USER_MODEL_ID = "ai.bigbud.desktop";
const LINUX_DESKTOP_ENTRY_NAME = isDevelopment ? "bigbud-dev.desktop" : "bigbud.desktop";
const LINUX_WM_CLASS = isDevelopment ? "bigbud-dev" : "bigbud";
const USER_DATA_DIR_NAME = isDevelopment ? "bigbud-dev" : "bigbud";
const LEGACY_USER_DATA_DIR_NAME = isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)";
const LOG_DIR = Path.join(STATE_DIR, "logs");
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_FILE_MAX_FILES = 10;
const APP_RUN_ID = Crypto.randomBytes(6).toString("hex");
const SERVER_SETTINGS_PATH = Path.join(STATE_DIR, "settings.json");

// ---------------------------------------------------------------------------
// App-level types
// ---------------------------------------------------------------------------

type LinuxDesktopNamedApp = Electron.App & {
  setDesktopName?: (desktopName: string) => void;
};

// ---------------------------------------------------------------------------
// App-lifecycle state
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let desktopProtocolRegistered = false;
let desktopLogSink: RotatingFileSink | null = null;
let backendLogSink: RotatingFileSink | null = null;
let restoreStdIoCapture: (() => void) | null = null;

const desktopRuntimeInfo = resolveDesktopRuntimeInfo({
  platform: process.platform,
  processArch: process.arch,
  runningUnderArm64Translation: app.runningUnderARM64Translation === true,
});

// Resolved once after logging init.
const resolveIconPath = makeResolveIconPath(__dirname, process.resourcesPath ?? "");

// ---------------------------------------------------------------------------
// Logging convenience wrapper
// ---------------------------------------------------------------------------

function logHeader(message: string): void {
  writeDesktopLogHeader(message, desktopLogSink, APP_RUN_ID);
}

// ---------------------------------------------------------------------------
// Desktop protocol (custom t3:// scheme for packaged builds)
// ---------------------------------------------------------------------------

protocol.registerSchemesAsPrivileged([
  {
    scheme: DESKTOP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      // Required for navigator.mediaDevices.getUserMedia to work on the custom
      // protocol origin in production builds (otherwise Chrome treats the origin
      // as non-streaming and rejects media device requests).
      stream: true,
    },
  },
]);

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

function registerDesktopProtocol(): void {
  if (isDevelopment || desktopProtocolRegistered) return;

  const staticRoot = resolveDesktopStaticDir(ROOT_DIR);
  if (!staticRoot) {
    throw new Error(
      "Desktop static bundle missing. Build apps/server (with bundled client) first.",
    );
  }

  const staticRootResolved = Path.resolve(staticRoot);
  const staticRootPrefix = `${staticRootResolved}${Path.sep}`;
  const fallbackIndex = Path.join(staticRootResolved, "index.html");

  protocol.registerFileProtocol(DESKTOP_SCHEME, (request, callback) => {
    try {
      const candidate = resolveDesktopStaticPath(staticRootResolved, request.url);
      const resolvedCandidate = Path.resolve(candidate);
      const isInRoot =
        resolvedCandidate === fallbackIndex || resolvedCandidate.startsWith(staticRootPrefix);
      const isAssetRequest = isStaticAssetRequest(request.url);

      if (!isInRoot || !FS.existsSync(resolvedCandidate)) {
        if (isAssetRequest) {
          callback({ error: -6 });
          return;
        }
        callback({ path: fallbackIndex });
        return;
      }

      callback({ path: resolvedCandidate });
    } catch {
      callback({ path: fallbackIndex });
    }
  });

  desktopProtocolRegistered = true;
}

// ---------------------------------------------------------------------------
// App identity
// ---------------------------------------------------------------------------

/**
 * Resolve the Electron userData directory path.
 *
 * Electron derives the default userData path from `productName` in
 * package.json, which would produce directories with spaces and parentheses
 * (e.g. `~/.config/bigbud (Alpha)` on Linux). This is
 * unfriendly for shell usage and violates Linux naming conventions.
 *
 * We override it to a clean lowercase name (`bigbud`). If the legacy
 * `T3 Code (...)` directory already exists we keep using it so existing users don't
 * lose their Chromium profile data (localStorage, cookies, sessions).
 */
function resolveUserDataPath(): string {
  const appDataBase =
    process.platform === "win32"
      ? process.env.APPDATA || Path.join(OS.homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? Path.join(OS.homedir(), "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME || Path.join(OS.homedir(), ".config");

  const legacyPath = Path.join(appDataBase, LEGACY_USER_DATA_DIR_NAME);
  if (FS.existsSync(legacyPath)) {
    return legacyPath;
  }

  return Path.join(appDataBase, USER_DATA_DIR_NAME);
}

function configureAppIdentity(): void {
  app.setName(APP_DISPLAY_NAME);
  const commitHash = resolveAboutCommitHash(ROOT_DIR);
  app.setAboutPanelOptions({
    applicationName: APP_DISPLAY_NAME,
    applicationVersion: app.getVersion(),
    version: commitHash ?? "unknown",
  });

  if (process.platform === "win32") {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }

  if (process.platform === "linux") {
    (app as LinuxDesktopNamedApp).setDesktopName?.(LINUX_DESKTOP_ENTRY_NAME);
  }

  if (process.platform === "darwin" && app.dock) {
    const iconPath = resolveIconPath("png");
    if (iconPath) {
      app.dock.setIcon(iconPath);
    }
  }
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

if (process.platform === "linux") {
  app.commandLine.appendSwitch("class", LINUX_WM_CLASS);
}

// Override Electron's userData path before the `ready` event so that
// Chromium session data uses a filesystem-friendly directory name.
// Must be called synchronously at the top level — before `app.whenReady()`.
app.setPath("userData", resolveUserDataPath());

configureAppIdentity();

// ---------------------------------------------------------------------------
// Window factory (thin wrapper that closes over main.ts state)
// ---------------------------------------------------------------------------

function makeWindow(): BrowserWindow {
  return createWindow({
    appDisplayName: APP_DISPLAY_NAME,
    desktopScheme: DESKTOP_SCHEME,
    isDevelopment,
    desktopDir: __dirname,
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
  const port = await resolveDesktopBackendPort({
    host: "127.0.0.1",
    startPort: DEFAULT_DESKTOP_BACKEND_PORT,
  });
  logHeader(
    `selected backend port via sequential scan startPort=${DEFAULT_DESKTOP_BACKEND_PORT} port=${port}`,
  );
  const authToken = Crypto.randomBytes(24).toString("hex");
  const baseUrl = `ws://127.0.0.1:${port}`;
  const wsUrl = `${baseUrl}/?token=${encodeURIComponent(authToken)}`;
  setBackendConnectionInfo({ port, authToken, wsUrl });
  logHeader(`bootstrap resolved websocket endpoint baseUrl=${baseUrl}`);

  registerIpcHandlers({
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
    getMainWindow: () => mainWindow,
    getBackendWsUrl: () => backendWsUrl,
    getIsQuitting: () => isQuitting,
    getUpdateState,
    isUpdaterConfigured: () => updaterConfigured,
    checkForUpdates,
    downloadAvailableUpdate,
    installDownloadedUpdate,
    resolveIconPath,
  });
  logHeader("bootstrap ipc handlers registered");
  startBackend();
  logHeader("bootstrap backend start requested");
  mainWindow = makeWindow();
  logHeader("bootstrap main window created");
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

    initBackendManager({
      rootDir: ROOT_DIR,
      baseDir: BASE_DIR,
      serverSettingsPath: SERVER_SETTINGS_PATH,
      getIsQuitting: () => isQuitting,
      getBackendLogSink: () => backendLogSink,
      runId: APP_RUN_ID,
    });

    configureAppIdentity();
    registerDesktopProtocol();
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
