import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let resolvePendingPort: (port: number) => void = () => undefined;

const mocks = vi.hoisted(() => {
  return {
    events: [] as string[],
    initializeBrowserSession: vi.fn(() => {
      mocks.events.push("browser session");
    }),
    resolveDesktopBackendPort: vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolvePendingPort = resolve;
        }),
    ),
    resolvePort: (port: number) => resolvePendingPort(port),
    beginInstalledProcessQuiescence: vi.fn(() => mocks.events.push("quiesce")),
    stopBackendAndWaitForExit: vi.fn(async () => mocks.events.push("backend stopped")),
    stopCuaDriverDaemonAndWait: vi.fn(async () => mocks.events.push("daemon stopped")),
    stopCuaDriverCommandsAndWait: vi.fn(async () => mocks.events.push("commands stopped")),
    sweepWindowsCuaDriverProcesses: vi.fn(() => mocks.events.push("exact-path sweep")),
    assertWindowsFilesReplaceable: vi.fn(() => mocks.events.push("runtime lock probe")),
    getInstalledProcessTreeUncertainty: vi.fn<() => Error | null>(() => null),
    updaterDeps: null as {
      beginUpdatePreparation: () => void;
      prepareForUpdateInstall: () => Promise<void>;
    } | null,
    configureAutoUpdater: vi.fn(
      (deps: {
        beginUpdatePreparation: () => void;
        prepareForUpdateInstall: () => Promise<void>;
      }) => {
        mocks.updaterDeps = deps;
      },
    ),
  };
});

vi.mock("./backend/backendManager", () => ({
  backendPort: 3000,
  backendWsUrl: "ws://127.0.0.1:3000",
  setBackendConnectionInfo: vi.fn(),
  startBackend: vi.fn(async () => undefined),
  stopBackendAndWaitForExit: mocks.stopBackendAndWaitForExit,
}));
vi.mock("./backend/tailscaleRemoteAccess", () => ({
  disableDesktopTailscaleRemoteAccess: vi.fn(),
  enableDesktopTailscaleRemoteAccess: vi.fn(),
  getDesktopTailscaleRemoteAccessStatus: vi.fn(async () => ({ serving: false })),
}));
vi.mock("./backend/cuaDriver", () => ({
  getComputerUsePermissionsStatus: vi.fn(),
  getComputerUseRuntimeStatus: vi.fn(),
  installComputerUseRuntime: vi.fn(),
  requestComputerUsePermissions: vi.fn(),
  resolveComputerUseRuntime: vi.fn(() => ({
    binaryPath: String.raw`C:\Program Files\bigbud\cua-driver.exe`,
  })),
  runComputerUseDoctor: vi.fn(),
}));
vi.mock("./backend/cuaDriver.daemon", () => ({
  stopCuaDriverDaemon: vi.fn(),
  stopCuaDriverDaemonAndWait: mocks.stopCuaDriverDaemonAndWait,
}));
vi.mock("./backend/cuaDriver.process", () => ({
  stopCuaDriverCommandsAndWait: mocks.stopCuaDriverCommandsAndWait,
}));
vi.mock("./backend/cuaDriver.windowsSweep", () => ({
  sweepWindowsCuaDriverProcesses: mocks.sweepWindowsCuaDriverProcesses,
}));
vi.mock("./backend/windowsFileReplaceability", () => ({
  assertWindowsFilesReplaceable: mocks.assertWindowsFilesReplaceable,
}));
vi.mock("./updater/windowsUpdateTargets", () => ({
  resolveWindowsUpdateTargets: vi.fn(() => [
    { label: "the packaged workspace agent", path: String.raw`C:\app\agent.exe` },
  ]),
}));
vi.mock("./backend/installedProcessQuiescence", () => ({
  beginInstalledProcessQuiescence: mocks.beginInstalledProcessQuiescence,
  getInstalledProcessTreeUncertainty: mocks.getInstalledProcessTreeUncertainty,
}));
vi.mock("./backend/cuaDriver.lifecycle", () => ({
  makeCuaDriverLifecycle: vi.fn(() => ({ refresh: vi.fn() })),
  requestCuaDriverPermissionsAfterHostPreflight: vi.fn(),
}));
vi.mock("./backend/cuaHostPermissions", () => ({ requestHostAccessibilityPermission: vi.fn() }));
vi.mock("./updater/autoUpdater", () => ({
  configureAutoUpdater: mocks.configureAutoUpdater,
  checkForUpdates: vi.fn(),
  downloadAvailableUpdate: vi.fn(),
  getUpdateState: vi.fn(),
  installDownloadedUpdate: vi.fn(),
  updaterConfigured: false,
}));
vi.mock("./window/ipcHandlers", () => ({ registerIpcHandlers: vi.fn() }));
vi.mock("./window/browserSession", () => ({
  initializeBrowserSession: mocks.initializeBrowserSession,
}));
vi.mock("./backend/backendPort", () => ({
  DEFAULT_DESKTOP_BACKEND_PORT: 3000,
  resolveDesktopBackendPort: () => {
    mocks.events.push("resolve port");
    return mocks.resolveDesktopBackendPort();
  },
}));
vi.mock("./backend/mobileRemoteNetwork", () => ({
  resolveDesktopMobileRemoteNetwork: vi.fn(() => ({
    advertisedHost: "127.0.0.1",
    bindHost: "127.0.0.1",
    clientHost: "127.0.0.1",
  })),
}));
vi.mock("./backend/syncShellEnvironment", () => ({
  syncShellEnvironmentAsync: vi.fn(async () => undefined),
}));
vi.mock("./backend/backendStartupState", () => ({ getBackendStartupState: vi.fn() }));

import { bootstrapDesktop } from "./main.bootstrap";
import { createUpdateInstallCoordinator } from "./updater/autoUpdater.install";

const originalPlatform = process.platform;

function makeBootstrapOptions(): Parameters<typeof bootstrapDesktop>[0] {
  return {
    baseDir: "/base",
    channels: {} as never,
    cuaDriverHostBundleId: "bundle-id",
    desktopPreferences: { get: () => ({ floatingAssistantEnabled: false }) } as never,
    desktopRuntimeInfo: {} as never,
    floatingAssistantWindows: { ensureMascot: vi.fn() } as never,
    getIsQuitting: () => false,
    getMainWindow: () => null,
    isDevelopment: false,
    isPackaged: true,
    logHeader: vi.fn(),
    makeWindow: vi.fn() as never,
    prepareForAppQuit: vi.fn(),
    registerFloatingAssistantIpc: vi.fn(),
    resolveIconPath: () => null,
    resourcesPath: String.raw`C:\Program Files\bigbud\resources`,
    serverSettingsPath: "/settings.json",
    setIsQuitting: vi.fn(),
    setMainWindow: vi.fn(),
    windowRegistry: { isTrusted: vi.fn() } as never,
  };
}

describe("bootstrapDesktop", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    mocks.events.length = 0;
    mocks.beginInstalledProcessQuiescence
      .mockReset()
      .mockImplementation(() => mocks.events.push("quiesce"));
    mocks.stopBackendAndWaitForExit
      .mockReset()
      .mockImplementation(async () => mocks.events.push("backend stopped"));
    mocks.stopCuaDriverDaemonAndWait
      .mockReset()
      .mockImplementation(async () => mocks.events.push("daemon stopped"));
    mocks.stopCuaDriverCommandsAndWait
      .mockReset()
      .mockImplementation(async () => mocks.events.push("commands stopped"));
    mocks.sweepWindowsCuaDriverProcesses
      .mockReset()
      .mockImplementation(() => mocks.events.push("exact-path sweep"));
    mocks.assertWindowsFilesReplaceable
      .mockReset()
      .mockImplementation(() => mocks.events.push("runtime lock probe"));
    mocks.getInstalledProcessTreeUncertainty.mockReset().mockReturnValue(null);
    mocks.updaterDeps = null;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  });

  it("initializes the browser session before awaiting backend bootstrap", async () => {
    mocks.events.length = 0;
    const bootstrap = bootstrapDesktop(makeBootstrapOptions());

    expect(mocks.events).toEqual(["browser session", "resolve port"]);

    mocks.resolvePort(3001);
    await bootstrap;
  });

  it("orders quiescence, tracked cleanup, exact-path sweep, and updater handoff", async () => {
    const bootstrap = bootstrapDesktop(makeBootstrapOptions());
    mocks.resolvePort(3001);
    await bootstrap;
    mocks.events.length = 0;
    const coordinator = createUpdateInstallCoordinator({
      beginUpdatePreparation: mocks.updaterDeps!.beginUpdatePreparation,
      canInstall: () => true,
      clearUpdateTimers: vi.fn(),
      formatError: String,
      getIsQuitting: () => false,
      onHandoffFailure: vi.fn(),
      onInstallStart: vi.fn(),
      onRestartRequiredPreparationFailure: vi.fn(),
      platform: "win32",
      prepareForUpdateInstall: mocks.updaterDeps!.prepareForUpdateInstall,
      quitAndInstall: () => mocks.events.push("updater handoff"),
      setIsQuitting: vi.fn(),
    });

    await coordinator.install();

    expect(mocks.events).toEqual([
      "quiesce",
      "backend stopped",
      "daemon stopped",
      "commands stopped",
      "exact-path sweep",
      "runtime lock probe",
      "updater handoff",
    ]);
    expect(mocks.sweepWindowsCuaDriverProcesses).toHaveBeenCalledWith({
      executablePath: String.raw`C:\Program Files\bigbud\cua-driver.exe`,
    });
  });

  it("attempts CUA cleanup after backend failure and propagates all cleanup failures", async () => {
    mocks.stopBackendAndWaitForExit.mockRejectedValue(new Error("backend live"));
    mocks.stopCuaDriverDaemonAndWait.mockRejectedValue(new Error("CUA live"));
    mocks.stopCuaDriverCommandsAndWait.mockRejectedValue(new Error("probe live"));
    mocks.sweepWindowsCuaDriverProcesses.mockImplementation(() => {
      throw new Error("exact-path process live");
    });
    const bootstrap = bootstrapDesktop(makeBootstrapOptions());
    mocks.resolvePort(3001);
    await bootstrap;

    const preparation = mocks.updaterDeps?.prepareForUpdateInstall();

    await expect(preparation).rejects.toThrow("exact-path process live");
    expect(mocks.stopCuaDriverDaemonAndWait).toHaveBeenCalledOnce();
    expect(mocks.stopCuaDriverCommandsAndWait).toHaveBeenCalledOnce();
    expect(mocks.sweepWindowsCuaDriverProcesses).toHaveBeenCalledOnce();
    expect(mocks.assertWindowsFilesReplaceable).toHaveBeenCalledOnce();
  });

  it("blocks handoff and marks a sweep failure as restart-required", async () => {
    mocks.sweepWindowsCuaDriverProcesses.mockImplementation(() => {
      throw new Error("sweep access denied");
    });
    const bootstrap = bootstrapDesktop(makeBootstrapOptions());
    mocks.resolvePort(3001);
    await bootstrap;
    const handoff = vi.fn();
    const restartRequiredFailure = vi.fn();
    const coordinator = createUpdateInstallCoordinator({
      beginUpdatePreparation: mocks.updaterDeps!.beginUpdatePreparation,
      canInstall: () => true,
      clearUpdateTimers: vi.fn(),
      formatError: (error) => (error instanceof Error ? error.message : String(error)),
      getIsQuitting: () => false,
      onHandoffFailure: vi.fn(),
      onInstallStart: vi.fn(),
      onRestartRequiredPreparationFailure: restartRequiredFailure,
      platform: "win32",
      prepareForUpdateInstall: mocks.updaterDeps!.prepareForUpdateInstall,
      quitAndInstall: handoff,
      setIsQuitting: vi.fn(),
    });

    await coordinator.install();

    expect(handoff).not.toHaveBeenCalled();
    expect(restartRequiredFailure).toHaveBeenCalledWith(
      "sweep access denied Restart bigbud before trying to install again.",
    );
  });

  it("blocks handoff when a surviving known packaged child keeps its file locked", async () => {
    mocks.assertWindowsFilesReplaceable.mockImplementation(() => {
      throw new Error("packaged workspace agent remains locked");
    });
    const bootstrap = bootstrapDesktop(makeBootstrapOptions());
    mocks.resolvePort(3001);
    await bootstrap;
    const handoff = vi.fn();
    const restartRequiredFailure = vi.fn();
    const coordinator = createUpdateInstallCoordinator({
      beginUpdatePreparation: mocks.updaterDeps!.beginUpdatePreparation,
      canInstall: () => true,
      clearUpdateTimers: vi.fn(),
      formatError: (error) => (error instanceof Error ? error.message : String(error)),
      getIsQuitting: () => false,
      onHandoffFailure: vi.fn(),
      onInstallStart: vi.fn(),
      onRestartRequiredPreparationFailure: restartRequiredFailure,
      platform: "win32",
      prepareForUpdateInstall: mocks.updaterDeps!.prepareForUpdateInstall,
      quitAndInstall: handoff,
      setIsQuitting: vi.fn(),
    });

    await coordinator.install();

    expect(handoff).not.toHaveBeenCalled();
    expect(restartRequiredFailure).toHaveBeenCalledWith(
      expect.stringContaining("packaged workspace agent remains locked"),
    );
  });

  it("propagates prior Windows process-tree uncertainty on a later preparation attempt", async () => {
    mocks.getInstalledProcessTreeUncertainty.mockReturnValue(
      new Error("Windows process tree remains uncertain until bigbud restarts."),
    );
    const bootstrap = bootstrapDesktop(makeBootstrapOptions());
    mocks.resolvePort(3001);
    await bootstrap;

    await expect(mocks.updaterDeps?.prepareForUpdateInstall()).rejects.toThrow(
      "Windows process tree remains uncertain until bigbud restarts.",
    );
  });
});
