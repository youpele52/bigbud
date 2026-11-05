import type { DesktopBridge, DesktopComputerUseRuntimeStatus } from "@bigbud/contracts";

/** Desktop bridge stub for native API tests; every capability reports "not available". */
const MISSING_RUNTIME_STATUS: DesktopComputerUseRuntimeStatus = {
  available: false,
  ready: false,
  repairRequired: true,
  state: "missing",
  source: "missing",
  binaryPath: null,
  version: null,
  expectedVersion: "0.9.1",
  manifestSchema: null,
  policyVersion: null,
  policySha256: null,
  daemonState: "stopped",
  platform: "darwin",
  architecture: "arm64",
  platformHealth: "degraded",
  healthSummary: null,
  lastError: null,
  message: "Computer Use runtime is not installed yet.",
  diagnostics: null,
};

export function makeDesktopBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    getWsUrl: () => null,
    getMobileBackendBaseUrl: () => null,
    getBackendStartupState: async () => ({ generation: 0, startedAt: 0, status: "idle" }),
    onBackendStartupState: () => () => {},
    getComputerUseRuntimeStatus: async () => MISSING_RUNTIME_STATUS,
    getComputerUsePermissionsStatus: async () => ({
      runtimeAvailable: false,
      granted: false,
      message: "Computer Use runtime is not installed yet.",
      permissions: [],
    }),
    requestComputerUsePermissions: async () => ({
      runtimeAvailable: false,
      granted: false,
      message: "Computer Use runtime is not installed yet.",
      permissions: [],
    }),
    installComputerUseRuntime: async () => ({
      ok: false,
      status: MISSING_RUNTIME_STATUS,
    }),
    runComputerUseDoctor: async () => MISSING_RUNTIME_STATUS,
    getTailscaleRemoteAccessStatus: async () => ({
      installed: false,
      running: false,
      online: false,
      serving: false,
      remoteBaseUrl: null,
      error: "Tailscale CLI is not installed.",
    }),
    enableTailscaleRemoteAccess: async () => ({
      installed: false,
      running: false,
      online: false,
      serving: false,
      remoteBaseUrl: null,
      error: "Tailscale CLI is not installed.",
    }),
    disableTailscaleRemoteAccess: async () => ({
      installed: false,
      running: false,
      online: false,
      serving: false,
      remoteBaseUrl: null,
      error: "Tailscale CLI is not installed.",
    }),
    getFilePath: () => "",
    pickFolder: async () => null,
    confirm: async () => true,
    onCertificateChallenge: () => () => undefined,
    resolveCertificateChallenge: async () => false,
    setTheme: async () => undefined,
    setWindowMaterial: async () => undefined,
    showContextMenu: async () => null,
    openExternal: async () => true,
    onMenuAction: () => () => undefined,
    getUpdateState: async () => {
      throw new Error("getUpdateState not implemented in test");
    },
    checkForUpdate: async () => {
      throw new Error("checkForUpdate not implemented in test");
    },
    downloadUpdate: async () => {
      throw new Error("downloadUpdate not implemented in test");
    },
    installUpdate: async () => {
      throw new Error("installUpdate not implemented in test");
    },
    onUpdateState: () => () => undefined,
    notifications: {
      isSupported: async () => false,
      show: async () => false,
    },
    copyToClipboard: async () => undefined,
    requestFileAccess: async () => ({ success: false, granted: [], denied: [] }),
    ...overrides,
  };
}
