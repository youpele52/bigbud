export type DesktopComputerUseRuntimeSource = "bundled" | "managed" | "system" | "missing";

export interface DesktopComputerUsePermissionItem {
  readonly name: string;
  readonly granted: boolean;
}

export interface DesktopComputerUsePermissionSource {
  readonly attribution: string | null;
  readonly embedded: boolean | null;
  readonly hostBundleId: string | null;
}

export interface DesktopComputerUsePermissionsStatus {
  readonly runtimeAvailable: boolean;
  readonly granted: boolean;
  readonly message: string | null;
  readonly pendingHostAccessibilityApproval?: boolean;
  readonly permissions: ReadonlyArray<DesktopComputerUsePermissionItem>;
  readonly source?: DesktopComputerUsePermissionSource;
}

export interface DesktopComputerUseRuntimeStatus {
  available: boolean;
  ready: boolean;
  repairRequired: boolean;
  state:
    | "missing"
    | "installed-unvalidated"
    | "incompatible"
    | "starting"
    | "ready"
    | "degraded"
    | "unavailable";
  source: DesktopComputerUseRuntimeSource;
  binaryPath: string | null;
  version: string | null;
  expectedVersion: string;
  manifestSchema: string | null;
  policyVersion: string | null;
  policySha256: string | null;
  daemonState: "stopped" | "starting" | "ready" | "restarting" | "degraded";
  platform: string;
  architecture: string;
  platformHealth: "ready" | "degraded" | "unsupported";
  healthSummary: string | null;
  lastError: string | null;
  message: string | null;
  diagnostics: string | null;
}

export interface DesktopComputerUseInstallResult {
  ok: boolean;
  status: DesktopComputerUseRuntimeStatus;
}

export interface DesktopComputerUseBridge {
  getComputerUseRuntimeStatus: () => Promise<DesktopComputerUseRuntimeStatus>;
  getComputerUsePermissionsStatus: () => Promise<DesktopComputerUsePermissionsStatus>;
  requestComputerUsePermissions: () => Promise<DesktopComputerUsePermissionsStatus>;
  installComputerUseRuntime: () => Promise<DesktopComputerUseInstallResult>;
  runComputerUseDoctor: () => Promise<DesktopComputerUseRuntimeStatus>;
}
