import type { LogSink } from "../logging/logging";
import type { ComputerUseOwnerAccess } from "./backendBootstrapEnvelope";

export interface BackendManagerDeps {
  readonly rootDir: string;
  readonly baseDir: string;
  /** Legacy Cua runtime base; a dev-only state root in development (see main config). */
  readonly cuaDriverBaseDir: string;
  /** One-use owner access for this start; absent or null (today) leaves the envelope unchanged. */
  readonly getComputerUseOwnerAccess?: () => ComputerUseOwnerAccess | null;
  readonly backendMaxOldSpaceMb: number | null;
  readonly cuaDriverHostBundleId: string;
  readonly serverSettingsPath: string;
  readonly getIsQuitting: () => boolean;
  readonly getBackendLogSink: () => LogSink | null;
  readonly isDevelopmentDiagnostics: boolean;
  readonly runId: string;
}
