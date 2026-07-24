import * as FS from "node:fs";
import * as Path from "node:path";

import { app } from "electron";
import { makeCuaDriverChildEnvironment } from "@bigbud/shared/cua-driver/childEnvironment";
import {
  CUA_DRIVER_POLICY_SHA256,
  CUA_DRIVER_POLICY_VERSION,
  CUA_DRIVER_POLICY_YAML,
} from "@bigbud/shared/cua-driver/policy";
import { CUA_DRIVER_VERSION } from "@bigbud/shared/cua-driver/release";
import type {
  DesktopComputerUseInstallResult,
  DesktopComputerUsePermissionsStatus,
  DesktopComputerUseRuntimeSource,
  DesktopComputerUseRuntimeStatus,
} from "@bigbud/contracts";

import {
  checkComputerUsePermissions,
  missingComputerUsePermissionsStatus,
} from "./cuaDriver.permissions";
import { installManagedComputerUseRuntime } from "./cuaDriver.install";
import { validateCuaDriverPolicy } from "./cuaDriver.manifest";
import {
  getCuaDriverDaemonEnvironment,
  getCuaDriverDaemonStatus,
  refreshCuaDriverDaemonHealth,
} from "./cuaDriver.daemon";
import { binaryName, resolveManagedPaths } from "./cuaDriver.paths";
import { runCommand } from "./cuaDriver.process";

function resolveBundledBinaryPath(): string | null {
  if (!app.isPackaged) {
    return null;
  }

  const candidates = [
    process.platform === "darwin"
      ? Path.join(
          process.resourcesPath,
          "server",
          "cua-driver",
          "CuaDriver.app",
          "Contents",
          "MacOS",
          "cua-driver",
        )
      : null,
    Path.join(process.resourcesPath, "server", "cua-driver", "bin", binaryName()),
  ];

  for (const candidate of candidates) {
    if (candidate && FS.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveBundledPolicyPath(): string | null {
  if (!app.isPackaged) return null;
  const policyPath = Path.join(
    process.resourcesPath,
    "server",
    "cua-driver",
    "policy",
    "bigbud.yaml",
  );
  try {
    validateCuaDriverPolicy(policyPath);
    return policyPath;
  } catch {
    return null;
  }
}

function ensureCanonicalPolicy(policyPath: string): string {
  try {
    validateCuaDriverPolicy(policyPath);
    return policyPath;
  } catch {
    FS.mkdirSync(Path.dirname(policyPath), { recursive: true });
    const temporaryPath = `${policyPath}.${process.pid}.tmp`;
    FS.writeFileSync(temporaryPath, CUA_DRIVER_POLICY_YAML, { encoding: "utf8", mode: 0o600 });
    FS.renameSync(temporaryPath, policyPath);
    validateCuaDriverPolicy(policyPath);
    return policyPath;
  }
}

interface ResolvedComputerUseRuntime {
  readonly source: DesktopComputerUseRuntimeSource;
  readonly binaryPath: string | null;
  readonly policyPath: string | null;
}

function readActivatedRuntime(pointerPath: string): ResolvedComputerUseRuntime | null {
  try {
    const active = JSON.parse(FS.readFileSync(pointerPath, "utf8")) as Record<string, unknown>;
    if (
      typeof active.binaryPath !== "string" ||
      typeof active.policyPath !== "string" ||
      active.policyVersion !== CUA_DRIVER_POLICY_VERSION ||
      active.policySha256 !== CUA_DRIVER_POLICY_SHA256 ||
      !FS.existsSync(active.binaryPath)
    ) {
      return null;
    }
    validateCuaDriverPolicy(active.policyPath);
    return { source: "managed", binaryPath: active.binaryPath, policyPath: active.policyPath };
  } catch {
    return null;
  }
}

function resolveSystemBinaryPath(): string | null {
  if (app.isPackaged && process.env.BIGBUD_CUA_ALLOW_SYSTEM_DRIVER !== "1") {
    return null;
  }
  const rawPath = process.env.PATH;
  if (!rawPath) {
    return null;
  }

  const directories = rawPath.split(Path.delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
          .split(";")
          .filter(Boolean)
          .map((value) => value.toLowerCase())
      : [""];
  const name = binaryName();

  for (const directory of directories) {
    if (process.platform === "win32") {
      const lowerName = name.toLowerCase();
      const hasExtension = extensions.some((extension) => lowerName.endsWith(extension));
      const candidates = hasExtension
        ? [Path.join(directory, name)]
        : extensions.map((extension) => Path.join(directory, `${name}${extension.toLowerCase()}`));

      for (const candidate of candidates) {
        if (FS.existsSync(candidate)) {
          return candidate;
        }
      }
      continue;
    }

    const candidate = Path.join(directory, name);
    if (FS.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveComputerUseRuntime(baseDir: string): ResolvedComputerUseRuntime {
  const bundledBinaryPath = resolveBundledBinaryPath();
  const bundledPolicyPath = resolveBundledPolicyPath();
  if (bundledBinaryPath && bundledPolicyPath) {
    return { source: "bundled", binaryPath: bundledBinaryPath, policyPath: bundledPolicyPath };
  }

  const managedPaths = resolveManagedPaths(baseDir);
  const activated = readActivatedRuntime(managedPaths.activePath);
  if (activated) return activated;
  const previous = readActivatedRuntime(managedPaths.previousPath);
  if (previous) return previous;
  if (FS.existsSync(managedPaths.legacyBinaryPath)) {
    return {
      source: "managed",
      binaryPath: managedPaths.legacyBinaryPath,
      policyPath: ensureCanonicalPolicy(managedPaths.policyPath),
    };
  }

  const systemBinaryPath = resolveSystemBinaryPath();
  if (systemBinaryPath) {
    return {
      source: "system",
      binaryPath: systemBinaryPath,
      policyPath: ensureCanonicalPolicy(managedPaths.policyPath),
    };
  }

  return { source: "missing", binaryPath: null, policyPath: null };
}

async function readVersion(binaryPath: string): Promise<string | null> {
  try {
    const result = await runCommand(
      binaryPath,
      ["--version"],
      makeCuaDriverChildEnvironment(process.env),
    );
    const output = [result.stdout, result.stderr].filter(Boolean).join(" ").trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

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

  const version = await readVersion(runtime.binaryPath);
  const daemon = getCuaDriverDaemonStatus();
  const versionMatches = version?.includes(CUA_DRIVER_VERSION) === true;
  const runtimeValidated = versionMatches && runtime.policyPath !== null;
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
      : !versionMatches
        ? "incompatible"
        : daemon.state === "starting" || daemon.state === "restarting"
          ? "starting"
          : daemon.state === "degraded"
            ? "degraded"
            : "installed-unvalidated",
    source: runtime.source,
    binaryPath: runtime.binaryPath,
    version,
    expectedVersion: CUA_DRIVER_VERSION,
    manifestSchema: "1",
    policyVersion: runtime.policyPath ? CUA_DRIVER_POLICY_VERSION : null,
    policySha256: runtime.policyPath ? CUA_DRIVER_POLICY_SHA256 : null,
    daemonState: daemon.state,
    platform: process.platform,
    architecture: process.arch,
    platformHealth: daemon.healthSummary === "ok" ? "ready" : "degraded",
    healthSummary: daemon.healthSummary,
    lastError: daemon.lastError,
    message: versionMatches ? null : `Expected cua-driver ${CUA_DRIVER_VERSION}.`,
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
