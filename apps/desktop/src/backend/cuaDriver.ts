import type { CuaDriverManifest } from "@bigbud/shared/cua-driver/manifest";
import {
  CUA_DRIVER_POLICY_SHA256,
  CUA_DRIVER_POLICY_VERSION,
} from "@bigbud/shared/cua-driver/policy";
import { CUA_DRIVER_VERSION } from "@bigbud/shared/cua-driver/release";
import type {
  DesktopComputerUseInstallResult,
  DesktopComputerUsePermissionsStatus,
  DesktopComputerUseRuntimeStatus,
} from "@bigbud/contracts";

import {
  checkComputerUsePermissions,
  missingComputerUsePermissionsStatus,
} from "./cuaDriver.permissions";
import { installManagedComputerUseRuntime } from "./cuaDriver.install";
import {
  getCuaDriverDaemonEnvironment,
  getCuaDriverDaemonStatus,
  refreshCuaDriverDaemonHealth,
} from "./cuaDriver.daemon";
import { resolvePrivateStateHome } from "./cuaDriver.paths";
import { resolveComputerUseRuntime } from "./cuaDriver.runtime";
import { validateCuaDriverRuntime } from "./cuaDriver.manifest";
import { cuaDriverRuntimeKey, getCuaDriverStartupFailure } from "./cuaDriver.startupFailure";

function missingStatus(): DesktopComputerUseRuntimeStatus {
  const daemon = getCuaDriverDaemonStatus();
  const platformSupported =
    (process.platform === "darwin" ||
      process.platform === "linux" ||
      process.platform === "win32") &&
    (process.arch === "arm64" || process.arch === "x64");
  return {
    available: false,
    ready: false,
    repairRequired: platformSupported,
    state: platformSupported ? "missing" : "unavailable",
    source: "missing",
    binaryPath: null,
    version: null,
    expectedVersion: CUA_DRIVER_VERSION,
    manifestSchema: null,
    policyVersion: null,
    policySha256: null,
    daemonState: daemon.state,
    platform: process.platform,
    architecture: process.arch,
    platformHealth: platformSupported ? "degraded" : "unsupported",
    healthSummary: daemon.healthSummary,
    lastError: daemon.lastError,
    message: "Computer Use runtime is not installed yet.",
    diagnostics: null,
  };
}

export async function getComputerUseRuntimeStatus(
  baseDir: string,
): Promise<DesktopComputerUseRuntimeStatus> {
  const runtime = resolveComputerUseRuntime(baseDir);
  if (!runtime.binaryPath || runtime.source === "missing") {
    return missingStatus();
  }

  let manifest: CuaDriverManifest | null = null;
  let compatibilityError = getCuaDriverStartupFailure(
    cuaDriverRuntimeKey(baseDir, runtime.binaryPath, runtime.policyPath),
  );
  try {
    manifest = await validateCuaDriverRuntime(
      runtime.binaryPath,
      runtime.policyPath ?? undefined,
      resolvePrivateStateHome(baseDir),
    );
  } catch (error) {
    compatibilityError = error instanceof Error ? error.message : String(error);
  }
  const daemon = getCuaDriverDaemonStatus();
  const runtimeValidated =
    manifest !== null && runtime.policyPath !== null && compatibilityError === null;
  const ready =
    daemon.state === "ready" && daemon.binaryPath === runtime.binaryPath && runtimeValidated;
  const repairRequired =
    !runtimeValidated ||
    daemon.state === "stopped" ||
    (daemon.state === "degraded" && daemon.repairRequired);
  return {
    available: true,
    ready,
    repairRequired,
    state: ready
      ? "ready"
      : !runtimeValidated
        ? "incompatible"
        : daemon.state === "starting" || daemon.state === "restarting"
          ? "starting"
          : daemon.state === "degraded"
            ? "degraded"
            : "installed-unvalidated",
    source: runtime.source,
    binaryPath: runtime.binaryPath,
    version: manifest?.binary_version ?? runtime.version,
    expectedVersion: CUA_DRIVER_VERSION,
    manifestSchema: manifest?.schema_version ?? null,
    policyVersion: runtime.policyPath ? CUA_DRIVER_POLICY_VERSION : null,
    policySha256: runtime.policyPath ? CUA_DRIVER_POLICY_SHA256 : null,
    daemonState: daemon.state,
    platform: process.platform,
    architecture: process.arch,
    platformHealth: daemon.healthSummary === "ok" ? "ready" : "degraded",
    healthSummary: daemon.healthSummary,
    lastError:
      compatibilityError ?? (daemon.binaryPath === runtime.binaryPath ? daemon.lastError : null),
    message:
      compatibilityError ?? (runtime.policyPath ? null : "Computer Use runtime policy is missing."),
    diagnostics: null,
  };
}

export function resolveComputerUseRuntimeEnv(baseDir: string): NodeJS.ProcessEnv {
  const runtime = resolveComputerUseRuntime(baseDir);
  if (!runtime.binaryPath || runtime.source === "missing") {
    return {};
  }

  return {
    BIGBUD_CUA_DRIVER_PATH: runtime.binaryPath,
    ...(runtime.policyPath ? { CUA_DRIVER_POLICY_FILE: runtime.policyPath } : {}),
  };
}

export async function installComputerUseRuntime(
  baseDir: string,
  hostBundleId: string,
): Promise<DesktopComputerUseInstallResult> {
  const currentStatus = await getComputerUseRuntimeStatus(baseDir);
  if (currentStatus.available && currentStatus.source === "bundled") {
    return {
      ok: true,
      status: currentStatus,
    };
  }
  return installManagedComputerUseRuntime({
    baseDir,
    getStatus: () => getComputerUseRuntimeStatus(baseDir),
    hostBundleId,
  });
}

export async function runComputerUseDoctor(
  baseDir: string,
): Promise<DesktopComputerUseRuntimeStatus> {
  const runtime = resolveComputerUseRuntime(baseDir);
  if (!runtime.binaryPath || runtime.source === "missing") {
    return missingStatus();
  }

  const failure = getCuaDriverStartupFailure(
    cuaDriverRuntimeKey(baseDir, runtime.binaryPath, runtime.policyPath),
  );
  if (failure)
    return {
      ...(await getComputerUseRuntimeStatus(baseDir)),
      message: failure,
      diagnostics: failure,
    };
  const health = await refreshCuaDriverDaemonHealth();
  const status = await getComputerUseRuntimeStatus(baseDir);
  return {
    ...status,
    message:
      health.overall === "ok"
        ? "Computer Use health checks passed."
        : `Computer Use health is ${health.overall}.`,
    diagnostics: health.diagnostics,
  };
}

function unreadyComputerUsePermissionsStatus(
  status: DesktopComputerUseRuntimeStatus,
): DesktopComputerUsePermissionsStatus {
  return missingComputerUsePermissionsStatus(
    `Computer Use runtime is ${status.state}. Repair the runtime before checking desktop permissions.`,
  );
}

export async function getComputerUsePermissionsStatus(
  baseDir: string,
): Promise<DesktopComputerUsePermissionsStatus> {
  const status = await getComputerUseRuntimeStatus(baseDir);
  if (status.repairRequired) {
    return unreadyComputerUsePermissionsStatus(status);
  }
  const runtime = resolveComputerUseRuntime(baseDir);
  if (!runtime.binaryPath || runtime.source === "missing") {
    return missingComputerUsePermissionsStatus(
      "Install the Computer Use runtime before checking desktop permissions.",
    );
  }

  const environment = getCuaDriverDaemonEnvironment();
  if (!environment) {
    return missingComputerUsePermissionsStatus(
      "The embedded Computer Use daemon is not available yet.",
    );
  }
  return checkComputerUsePermissions({
    binaryPath: runtime.binaryPath,
    environment,
  });
}

export async function requestComputerUsePermissions(
  baseDir: string,
): Promise<DesktopComputerUsePermissionsStatus> {
  const status = await getComputerUseRuntimeStatus(baseDir);
  if (status.repairRequired) {
    return unreadyComputerUsePermissionsStatus(status);
  }
  const runtime = resolveComputerUseRuntime(baseDir);
  if (!runtime.binaryPath || runtime.source === "missing") {
    return missingComputerUsePermissionsStatus(
      "Install the Computer Use runtime before requesting desktop permissions.",
    );
  }

  // macOS presents independent TCC dialogs for each capability. We deliberately
  // do not trigger them here: the desktop UI links users to the relevant System
  // Settings panes, then rechecks the host-owned grants without a prompt cascade.
  const environment = getCuaDriverDaemonEnvironment();
  if (!environment) {
    return missingComputerUsePermissionsStatus(
      "The embedded Computer Use daemon is not available yet.",
    );
  }
  return checkComputerUsePermissions({
    binaryPath: runtime.binaryPath,
    environment,
  });
}
