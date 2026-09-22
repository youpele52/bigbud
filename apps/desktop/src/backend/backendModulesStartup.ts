import * as FS from "node:fs";

import { app } from "electron";
import { resolveBackendModulesLinkPlan } from "../env/pathResolver.platform";
import { createBackendStartupDiagnostics } from "./backendStartupDiagnostics";
import { ensureWindowsBackendModulesPath } from "./backendModulesStartup.windows";
import {
  beginBackendStartup,
  getBackendStartupState,
  recordBackendStartupFailure,
} from "./backendStartupState";

export interface BackendModulesStartupOptions {
  readonly isPackaged: boolean;
  readonly platform: string;
  readonly resourcesPath: string;
}

export interface BackendModulesStartupFailure {
  readonly reason: "backend_modules_invalid";
  readonly message: string;
}

function recordBackendModulesStartupFailure(failure: BackendModulesStartupFailure): number {
  const generation = beginBackendStartup();
  recordBackendStartupFailure(
    generation,
    failure.reason,
    createBackendStartupDiagnostics({ category: "bootstrap", errorMessage: failure.message }),
  );
  return generation;
}

export function reportBackendModulesStartupFailure(
  failure: BackendModulesStartupFailure,
  log: (event: string, details: string) => void,
): void {
  const state = getBackendStartupState();
  if (state.status === "failed" && state.failureReason === failure.reason) return;
  const generation = recordBackendModulesStartupFailure(failure);
  log("backend_modules_invalid", `generation=${generation}`);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function invalidMacBundle(): BackendModulesStartupFailure {
  return {
    reason: "backend_modules_invalid",
    message: "Packaged macOS backend modules are missing or invalid.",
  };
}

function validateMacBackendModules(
  modulesDir: string,
  nodeModulesPath: string,
): BackendModulesStartupFailure | null {
  try {
    if (!FS.lstatSync(modulesDir).isDirectory()) return invalidMacBundle();
    const nodeModulesStat = FS.lstatSync(nodeModulesPath);
    if (!nodeModulesStat.isSymbolicLink()) return invalidMacBundle();
    if (FS.readlinkSync(nodeModulesPath) !== "_modules") return invalidMacBundle();
    return null;
  } catch {
    return invalidMacBundle();
  }
}

function ensureLinuxBackendModulesPath(modulesDir: string, nodeModulesPath: string): void {
  if (!FS.existsSync(modulesDir)) return;

  try {
    const stat = FS.lstatSync(nodeModulesPath);
    if (stat.isSymbolicLink()) return;
    FS.rmSync(nodeModulesPath, { recursive: true, force: true });
  } catch (error: unknown) {
    if (!isMissingFileError(error)) throw error;
  }

  try {
    FS.symlinkSync("_modules", nodeModulesPath, "dir");
    console.log("[desktop] created node_modules symlink (POSIX)");
  } catch (error) {
    console.error("[desktop] failed to create node_modules symlink:", error);
  }
}

/**
 * Prepares packaged backend module resolution. Development is a no-op. A
 * packaged macOS bundle is immutable at runtime, so its link is validated
 * without any filesystem mutation; Linux and Windows retain their existing
 * compatibility behavior.
 */
export function ensureBackendModulesPathForOptions(
  options: BackendModulesStartupOptions,
): BackendModulesStartupFailure | null {
  if (!options.isPackaged) return null;

  const plan = resolveBackendModulesLinkPlan(options.platform, options.resourcesPath);
  if (options.platform === "darwin") {
    return validateMacBackendModules(plan.modulesDir, plan.nodeModulesPath);
  }
  if (options.platform === "win32") {
    ensureWindowsBackendModulesPath(plan.modulesDir, plan.nodeModulesPath);
  } else {
    ensureLinuxBackendModulesPath(plan.modulesDir, plan.nodeModulesPath);
  }
  return null;
}

export function ensureBackendModulesPath(): BackendModulesStartupFailure | null {
  return ensureBackendModulesPathForOptions({
    isPackaged: app.isPackaged,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
  });
}
