import * as Crypto from "node:crypto";
import { preservePackagedCopilotRuntime } from "./backend/copilotRuntimeMigration";
import { startDesktopResourceAwareness } from "./main.systemMonitor";
import { makeMainOwnershipRecovery } from "./backend/ownershipRecovery.main";
import { registerOwnershipRecoveryIpc } from "./window/ipcHandlers.ownershipRecovery";
import type { SystemMonitorBridge } from "./system-monitor/bridge";

import type { BrowserWindow, WebContents } from "electron";

import {
  backendPort,
  backendHost,
  backendWsUrl,
  setBackendConnectionInfo,
  startBackend,
  stopBackendAndWaitForExit,
} from "./backend/backendManager";
import { createPrepareForUpdateInstall } from "./main.bootstrap.updateInstall";
import type { DesktopQuitTeardown } from "./main.quitTeardown";
import { makeDesktopMobileRemoteAccess } from "./main.bootstrap.tailscale";
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
import { registerCommandLineToolIpc } from "./commandLine/commandLineTool.ipc";
import { registerShellPathIpc } from "./window/shellPathHandlers";
import { initializeBrowserSession } from "./window/browserSession";
import type { DesktopWindowRegistry } from "./window/DesktopWindowRegistry";
import type { DesktopPreferencesStore } from "./window/desktopPreferences";
import type { FloatingAssistantWindows } from "./window/floatingAssistantWindows";
import { DEFAULT_DESKTOP_BACKEND_PORT, resolveDesktopBackendPort } from "./backend/backendPort";
import { resolveDesktopMobileRemoteNetwork } from "./backend/mobileRemoteNetwork";
import type { desktopIpcChannels } from "./main.channels";
import type { resolveDesktopMainConfig } from "./main.config";
import { syncShellEnvironmentAsync } from "./backend/syncShellEnvironment";
import { getBackendStartupState } from "./backend/backendStartupState";
import { registerTerminalRenderingIpc } from "./main.terminalRendering";
import { startDesktopConnectivitySignals } from "./connectivity/connectivitySignals.main";
import {
  registerComputerUseSafetySurface,
  startComputerUseGuard,
} from "./computer-use/computerUse.bootstrap";
import { configureIpcAuthorization } from "./window/ipcAuthorization";
import {
  createRemoteBackendWindows,
  registerRemoteBackendWindowIpc,
} from "./window/remoteBackendWindow";

interface BootstrapDesktopOptions {
  /** Legacy Cua runtime base (`cuaDriverBaseDir` in main config); used only for Cua. */
  readonly baseDir: string;
  readonly systemMonitor: SystemMonitorBridge;
  readonly channels: typeof desktopIpcChannels;
  readonly cuaDriverHostBundleId: string;
  /** Supervised guard inputs; it starts only when the selection gate is open. */
  readonly computerUseGuard: {
    readonly rootDir: string;
    readonly desktopDir: string;
    readonly developmentRoot: string | null;
  };
  readonly desktopPreferences: DesktopPreferencesStore;
  readonly desktopRuntimeInfo: ReturnType<typeof resolveDesktopMainConfig>["desktopRuntimeInfo"];
  readonly floatingAssistantWindows: FloatingAssistantWindows;
  readonly getIsQuitting: () => boolean;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly openMainWindow: (threadId?: string) => BrowserWindow;
  readonly isDevelopment: boolean;
  readonly isPackaged: boolean;
  readonly logHeader: (message: string) => void;
  readonly makeWindow: (searchParams?: Readonly<Record<string, string>>) => BrowserWindow;
  readonly prepareForAppQuit: (reason: string) => void;
  /** The acknowledged quit handshake; the updater runs it with reason `update` (F7). */
  readonly runQuitHandshake: DesktopQuitTeardown["runHandshake"];
  readonly registerFloatingAssistantIpc: () => void;
  readonly resolveIconPath: (ext: "ico" | "icns" | "png") => string | null;
  readonly resourcesPath: string;
  readonly serverSettingsPath: string;
  readonly tailscaleServeHttpsPort: number;
  readonly setIsQuitting: (value: boolean) => void;
  readonly setMainWindow: (window: BrowserWindow) => void;
  readonly windowRegistry: DesktopWindowRegistry;
}

export async function bootstrapDesktop(options: BootstrapDesktopOptions): Promise<void> {
  const {
    baseDir,
    systemMonitor,
    channels,
    cuaDriverHostBundleId,
    computerUseGuard,
    desktopPreferences,
    desktopRuntimeInfo,
    floatingAssistantWindows,
    getIsQuitting,
    getMainWindow,
    openMainWindow,
    isDevelopment,
    isPackaged,
    logHeader,
    makeWindow,
    prepareForAppQuit,
    runQuitHandshake,
    registerFloatingAssistantIpc,
    resolveIconPath,
    resourcesPath,
    serverSettingsPath,
    tailscaleServeHttpsPort,
    setIsQuitting,
    setMainWindow,
    windowRegistry,
  } = options;
  // Before any handler registration: every IPC handler authorizes its sender.
  configureIpcAuthorization(windowRegistry);
  const mobileRemoteAccess = makeDesktopMobileRemoteAccess({
    baseDir,
    tailscaleServeHttpsPort,
    getBackendPort: () => backendPort,
    getBackendHost: () => backendHost,
    getIsQuitting,
  });
  const cuaDriverLifecycle = makeCuaDriverLifecycle({
    stopBackendAndWaitForExit,
    stopCuaDriverDaemon,
    startBackend,
  });

  initializeBrowserSession();
  logHeader("bootstrap browser session initialized");
  logHeader("bootstrap start");
  // Lifeline closes on before-quit and, regardless, when this process exits.
  const computerUseGuardHandle = startComputerUseGuard({
    ...computerUseGuard,
    isDevelopment,
    isPackaged,
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    log: logHeader,
  });
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
  mobileRemoteAccess.setLocalBaseUrl(
    `http://${formatHostForUrl(desktopMobileRemoteNetwork.advertisedHost)}:${port}`,
  );
  setBackendConnectionInfo({
    port,
    authToken,
    wsUrl,
    host: desktopMobileRemoteNetwork.bindHost,
  });
  await mobileRemoteAccess.prepareGateway(serverSettingsPath, !isPackaged);
  await mobileRemoteAccess.getTailscaleRemoteAccessStatus();
  logHeader(
    `bootstrap resolved websocket endpoint baseUrl=${baseUrl} mobileBackendBaseUrl=${mobileRemoteAccess.getMobileBackendBaseUrl()}`,
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
    TAKE_OVER_TAILSCALE_REMOTE_ACCESS_CHANNEL: channels.takeOverTailscaleRemoteAccess,
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
    openMainWindow,
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
    getMobileBackendBaseUrl: mobileRemoteAccess.getMobileBackendBaseUrl,
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
    getTailscaleRemoteAccessStatus: mobileRemoteAccess.getTailscaleRemoteAccessStatus,
    enableTailscaleRemoteAccess: mobileRemoteAccess.enableTailscaleRemoteAccess,
    disableTailscaleRemoteAccess: mobileRemoteAccess.disableTailscaleRemoteAccess,
    takeOverTailscaleRemoteAccess: mobileRemoteAccess.takeOverTailscaleRemoteAccess,
  });
  await startDesktopResourceAwareness(
    systemMonitor,
    (sender) => windowRegistry.get("main")?.webContents.id === sender.id,
  ).catch(() => {
    logHeader("system monitor agent bridge unavailable");
  });
  registerTerminalRenderingIpc((sender) => {
    const role = windowRegistry.getRole(sender);
    return role === "main" || role === "compact-chat" || role === "remote-backend";
  });
  registerOwnershipRecoveryIpc(() => {
    const contents = getMainWindow()?.webContents;
    return contents && windowRegistry.isTrusted(contents) ? contents : undefined;
  }, makeMainOwnershipRecovery(getIsQuitting));
  registerFloatingAssistantIpc();
  registerRemoteBackendWindowIpc({
    channels,
    windows: createRemoteBackendWindows({ makeWindow, registry: windowRegistry }),
  });
  registerCommandLineToolIpc({
    channel: channels.installCommandLineTool,
    isPackaged,
    resourcesPath,
  });
  registerShellPathIpc();
  registerComputerUseSafetySurface({
    registry: windowRegistry,
    desktopDir: computerUseGuard.desktopDir,
    guard: computerUseGuardHandle,
    openMainWindow: () => openMainWindow(),
    menuActionChannel: channels.menuAction,
  });
  logHeader("bootstrap ipc handlers registered");
  startDesktopConnectivitySignals({
    channel: channels.connectivitySignal,
    getIsQuitting,
    logHeader,
  });
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
    // Preserve first: a failed copy must not fence CUA/backend process starts in the running app.
    beginUpdatePreparation: () => undefined,
    prepareForUpdateInstall: createPrepareForUpdateInstall({
      cuaDriverBaseDir: baseDir,
      isPackaged,
      resourcesPath,
      runQuitHandshake,
    }),
    onBeforeQuitForUpdate: () => {
      prepareForAppQuit("before-quit-for-update");
    },
  });
  logHeader("bootstrap auto updater configured");
  logHeader("bootstrap login shell hydration started");
  await syncShellEnvironmentAsync();
  logHeader("bootstrap login shell hydration completed");
  await preservePackagedCopilotRuntime(isPackaged, resourcesPath).catch((error) =>
    console.error(
      "[copilot-runtime] Bundle preservation failed; the bundled runtime remains usable.",
      error,
    ),
  );
  await startBackend();
  logHeader("bootstrap backend start requested");
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
