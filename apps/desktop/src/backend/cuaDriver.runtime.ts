import * as FS from "node:fs";
import * as Path from "node:path";

import { app } from "electron";
import {
  CUA_DRIVER_POLICY_SHA256,
  CUA_DRIVER_POLICY_VERSION,
  CUA_DRIVER_POLICY_YAML,
} from "@bigbud/shared/cua-driver/policy";
import { CUA_DRIVER_VERSION } from "@bigbud/shared/cua-driver/release";
import type { DesktopComputerUseRuntimeSource } from "@bigbud/contracts";

import { writeFileAtomically } from "./cuaDriver.atomicFile";
import { validateCuaDriverPolicy } from "./cuaDriver.manifest";
import { binaryName, resolveManagedPaths } from "./cuaDriver.paths";

/**
 * Runtime selection: bundled (packaged only) -> `active.json` ->
 * `previous.json` -> legacy `bin/` -> `PATH` (dev only) -> missing.
 */
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
    writeFileAtomically(policyPath, CUA_DRIVER_POLICY_YAML, 0o600);
    validateCuaDriverPolicy(policyPath);
    return policyPath;
  }
}

export interface ResolvedComputerUseRuntime {
  readonly source: DesktopComputerUseRuntimeSource;
  readonly binaryPath: string | null;
  readonly policyPath: string | null;
  /** Known Driver version (bundled, or recorded by the installer); `null` when unknown. */
  readonly version: string | null;
}

/**
 * The Driver version an activation pointer refers to: `runtimeVersion` on the
 * pointer (written since the lean upgrade), else the version directory's
 * `install-manifest.json`. `null` when neither is readable (unknown).
 */
export function readPointerRuntimeVersion(pointer: Record<string, unknown>): string | null {
  if (typeof pointer.runtimeVersion === "string") return pointer.runtimeVersion;
  if (typeof pointer.versionPath !== "string") return null;
  try {
    const manifest = JSON.parse(
      FS.readFileSync(Path.join(pointer.versionPath, "install-manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    return typeof manifest.runtimeVersion === "string" ? manifest.runtimeVersion : null;
  } catch {
    return null;
  }
}

/**
 * A pointer whose version is KNOWN and differs from the pin is skipped, so a
 * pin flip falls back to the retained generation (`previous.json`) without a
 * download. An unknown version keeps the previous behaviour (status still
 * checks `--version` against the pin).
 */
function readActivatedRuntime(pointerPath: string): ResolvedComputerUseRuntime | null {
  try {
    const active = JSON.parse(FS.readFileSync(pointerPath, "utf8")) as Record<string, unknown>;
    const runtimeVersion = readPointerRuntimeVersion(active);
    if (runtimeVersion !== null && runtimeVersion !== CUA_DRIVER_VERSION) return null;
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
    return {
      source: "managed",
      binaryPath: active.binaryPath,
      policyPath: active.policyPath,
      version: runtimeVersion,
    };
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
    return {
      source: "bundled",
      binaryPath: bundledBinaryPath,
      policyPath: bundledPolicyPath,
      version: CUA_DRIVER_VERSION,
    };
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
      version: null,
    };
  }

  const systemBinaryPath = resolveSystemBinaryPath();
  if (systemBinaryPath) {
    return {
      source: "system",
      binaryPath: systemBinaryPath,
      policyPath: ensureCanonicalPolicy(managedPaths.policyPath),
      version: null,
    };
  }

  return { source: "missing", binaryPath: null, policyPath: null, version: null };
}
