import {
  getBackendStartupState,
  recordBackendStartupDevelopmentDiagnostics,
  recordBackendStartupFailure,
} from "./backend/backendStartupState";
import {
  createBackendStartupDiagnostics,
  createDevelopmentBackendDiagnostics,
} from "./backend/backendStartupDiagnostics";

/**
 * Records a main-process crash against the current backend startup: a crash during startup
 * fails that startup; afterwards it only adds development diagnostics.
 */
export function recordMainProcessCrash(error: unknown, isDevelopmentDiagnostics: boolean): void {
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
