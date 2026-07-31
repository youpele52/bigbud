export type DesktopBackendStartupStatus =
  | "idle"
  | "starting"
  | "upgrading"
  | "ready"
  | "failed"
  | "timedOut";

export type DesktopBackendStartupFailureReason =
  | "server_entry_missing"
  | "bootstrap_failed"
  | "child_spawn_failed"
  | "child_exit_before_ready"
  | "projection_database_initialization_failed"
  | "server_runtime_startup_failed"
  | "startup_timed_out"
  | "unknown";

export type DesktopBackendStartupDiagnosticCategory =
  | "bootstrap"
  | "process"
  | "runtime"
  | "timeout";

export interface DesktopBackendStartupDiagnostics {
  readonly category: DesktopBackendStartupDiagnosticCategory;
  readonly occurredAt: string;
  readonly errorMessage?: string | undefined;
  readonly exitCode?: number | undefined;
  readonly exitSignal?: string | undefined;
  readonly stderrTail?: string | undefined;
}

/** Development-only crash context supplied by Electron main, never by the backend status pipe. */
export interface DesktopBackendDevelopmentDiagnostics {
  readonly capturedAt: string;
  readonly errorCause?: string | undefined;
  readonly errorMessage?: string | undefined;
  readonly errorName?: string | undefined;
  readonly errorStack?: string | undefined;
  readonly exitCode?: number | undefined;
  readonly exitSignal?: string | undefined;
  readonly stderrTail?: string | undefined;
}

export interface DesktopBackendStartupState {
  readonly generation: number;
  readonly startedAt: number;
  readonly status: DesktopBackendStartupStatus;
  readonly failureReason?: DesktopBackendStartupFailureReason | undefined;
  readonly diagnostics?: DesktopBackendStartupDiagnostics | undefined;
  /** Present only in an unpackaged Electron development runtime. */
  readonly developmentDiagnostics?: DesktopBackendDevelopmentDiagnostics | undefined;
}

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopRuntimePlatform = "darwin" | "linux" | "win32" | "other";

export interface DesktopRuntimeInfo {
  platform: DesktopRuntimePlatform;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  isCodeSigned: boolean;
}

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  currentVersion: string;
  platform: DesktopRuntimePlatform;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  isCodeSigned: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
}

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}
export interface DesktopUpdateCheckResult {
  checked: boolean;
  state: DesktopUpdateState;
}
