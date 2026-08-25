import { describe, expect, it, vi } from "vitest";

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
  };
});

vi.mock("./backend/backendManager", () => ({
  backendPort: 3000,
  backendWsUrl: "ws://127.0.0.1:3000",
  setBackendConnectionInfo: vi.fn(),
  startBackend: vi.fn(async () => undefined),
  stopBackendAndWaitForExit: vi.fn(),
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
  runComputerUseDoctor: vi.fn(),
}));
vi.mock("./backend/cuaDriver.daemon", () => ({ stopCuaDriverDaemon: vi.fn() }));
vi.mock("./backend/cuaDriver.lifecycle", () => ({
  makeCuaDriverLifecycle: vi.fn(() => ({ refresh: vi.fn() })),
  requestCuaDriverPermissionsAfterHostPreflight: vi.fn(),
}));
vi.mock("./backend/cuaHostPermissions", () => ({ requestHostAccessibilityPermission: vi.fn() }));
vi.mock("./updater/autoUpdater", () => ({
  configureAutoUpdater: vi.fn(),
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

describe("bootstrapDesktop", () => {
  it("initializes the browser session before awaiting backend bootstrap", async () => {
    mocks.events.length = 0;
    const bootstrap = bootstrapDesktop({
      baseDir: "/base",
      channels: {} as never,
      cuaDriverHostBundleId: "bundle-id",
      desktopPreferences: { get: () => ({ floatingAssistantEnabled: false }) } as never,
      desktopRuntimeInfo: {} as never,
      floatingAssistantWindows: { ensureMascot: vi.fn() } as never,
      getIsQuitting: () => false,
      getMainWindow: () => null,
      isDevelopment: false,
      logHeader: vi.fn(),
      makeWindow: vi.fn() as never,
      prepareForAppQuit: vi.fn(),
      registerFloatingAssistantIpc: vi.fn(),
      resolveIconPath: () => null,
      serverSettingsPath: "/settings.json",
      setIsQuitting: vi.fn(),
      setMainWindow: vi.fn(),
      windowRegistry: { isTrusted: vi.fn() } as never,
    });

    expect(mocks.events).toEqual(["browser session", "resolve port"]);

    mocks.resolvePort(3001);
    await bootstrap;
  });
});
