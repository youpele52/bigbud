export type DesktopComputerUseRuntimeSource = "bundled" | "managed" | "system" | "missing";

export interface DesktopComputerUsePermissionItem {
  readonly name: string;
  readonly granted: boolean;
}

export interface DesktopComputerUsePermissionsStatus {
  readonly runtimeAvailable: boolean;
  readonly granted: boolean;
  readonly message: string | null;
  readonly permissions: ReadonlyArray<DesktopComputerUsePermissionItem>;
}

export interface DesktopComputerUseRuntimeStatus {
  available: boolean;
  source: DesktopComputerUseRuntimeSource;
  binaryPath: string | null;
  version: string | null;
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
