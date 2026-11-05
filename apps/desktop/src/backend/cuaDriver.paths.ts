import * as FS from "node:fs";
import * as Path from "node:path";

import { CUA_DRIVER_VERSION } from "@bigbud/shared/cua-driver/release";

export function binaryName(): string {
  return process.platform === "win32" ? "cua-driver.exe" : "cua-driver";
}

export function resolveManagedPaths(baseDir: string) {
  const rootDir = Path.join(baseDir, "runtime", "cua-driver");
  const homeDir = Path.join(rootDir, "home");
  const downloadDir = Path.join(rootDir, "downloads");
  const versionsDir = Path.join(rootDir, "versions");
  return {
    rootDir,
    homeDir,
    downloadDir,
    versionsDir,
    activePath: Path.join(rootDir, "active.json"),
    previousPath: Path.join(rootDir, "previous.json"),
    policyPath: Path.join(rootDir, "policy", "bigbud.yaml"),
    legacyBinaryPath: Path.join(rootDir, "bin", binaryName()),
  };
}

/**
 * bigbud's private Driver state home (`BIGBUD_CUA_STATE_HOME`), created 0700 on
 * every use so an earlier default-mode creation is tightened too. Every Driver
 * child launched for `baseDir` (daemon, status polls, manifest validation,
 * activation helpers) must carry it.
 */
export function resolvePrivateStateHome(baseDir: string): string {
  const homeDir = resolveManagedPaths(baseDir).homeDir;
  FS.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  FS.chmodSync(homeDir, 0o700);
  return homeDir;
}

export function resolveManagedVersionPaths(
  baseDir: string,
  generation = "current",
): {
  readonly rootDir: string;
  readonly binDir: string;
  readonly binaryPath: string;
  readonly appPath: string;
  readonly policyPath: string;
  readonly installManifestPath: string;
} {
  const managed = resolveManagedPaths(baseDir);
  const platform = process.platform === "win32" ? "win32" : process.platform;
  const rootDir = Path.join(
    managed.versionsDir,
    `${CUA_DRIVER_VERSION}-${platform}-${process.arch}-${generation}`,
  );
  const binDir = Path.join(rootDir, "bin");
  return {
    rootDir,
    binDir,
    binaryPath: Path.join(binDir, binaryName()),
    appPath: Path.join(rootDir, "CuaDriver.app"),
    policyPath: Path.join(rootDir, "policy", "bigbud.yaml"),
    installManifestPath: Path.join(rootDir, "install-manifest.json"),
  };
}
