/**
 * Pure, platform-aware backend module path resolver.
 *
 * This module is the single place that decides HOW `_modules` is made visible
 * to the packaged backend's Node.js ESM resolver as `node_modules`.
 *
 * ## Background
 *
 * electron-builder silently strips directories named `node_modules` from
 * `extraResources` copies.  The build script works around this by renaming
 * the server's `node_modules` to `_modules` before electron-builder runs.
 * At runtime the desktop main process must recreate a path that Node.js ESM
 * resolution can find (it walks up the directory tree looking for
 * `node_modules/`).  `NODE_PATH` is NOT used because Node.js ESM ignores it —
 * only CJS honours `NODE_PATH`.
 *
 * ## Strategy by platform
 *
 * | Platform      | Link type  | Target format |
 * |---------------|------------|---------------|
 * | macOS / Linux | `dir`      | relative       |
 * | Windows       | `junction` | absolute       |
 *
 * Windows directory symlinks require Developer Mode or admin privileges, so
 * we use NTFS **junctions** instead.  Junctions:
 * - Do NOT require elevated privileges or Developer Mode on any modern Windows.
 * - Must point to an **absolute** path on the same NTFS volume.
 * - Are NOT traversed across volumes (fine here — both sides are inside the
 *   app's `Resources/` directory).
 *
 * If junction creation also fails (unlikely, but defensive), the plan includes
 * a `fallback` strategy:  copy `_modules` to `node_modules` so the packaged
 * backend can always start.  This is heavier but ensures correctness on
 * locked-down machines.
 */

import * as Path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The link type passed to `fs.symlinkSync` / `fs.symlink`.
 * `"junction"` is a Windows-only NTFS junction (no privilege needed).
 * `"dir"` is a standard directory symlink (POSIX standard).
 */
export type ModuleLinkType = "junction" | "dir";

/**
 * The complete plan for making `_modules` resolvable as `node_modules`.
 * The plan is pure data; execution is handled by `ensureBackendModulesPath`.
 */
export interface BackendModulesLinkPlan {
  /** Absolute path to the server directory inside `Resources/`. */
  readonly serverDir: string;
  /** Absolute path to the `_modules` directory that was staged by the build. */
  readonly modulesDir: string;
  /** Absolute path where `node_modules` should appear. */
  readonly nodeModulesPath: string;
  /**
   * The value passed as the `target` argument to `fs.symlinkSync`.
   * - POSIX: relative string `"_modules"` (keeps bundle relocatable).
   * - Windows: absolute path to `_modules` (junctions require absolute targets).
   */
  readonly linkTarget: string;
  /** The `type` argument for `fs.symlinkSync`. */
  readonly linkType: ModuleLinkType;
}

export interface PackagedOpencodeBinaryPlan {
  readonly serverDir: string;
  readonly opencodeDir: string;
  readonly binDir: string;
  readonly binaryName: string;
  readonly binaryPath: string;
}

// ---------------------------------------------------------------------------
// Pure resolver (no I/O, fully testable)
// ---------------------------------------------------------------------------

/**
 * Computes a `BackendModulesLinkPlan` for the given platform.
 *
 * @param platform   `process.platform` value (`"win32"`, `"darwin"`, `"linux"`, …)
 * @param resourcesPath  The Electron `process.resourcesPath` value for packaged
 *                       builds, or any directory in dev contexts.
 */
export function resolveBackendModulesLinkPlan(
  platform: string,
  resourcesPath: string,
): BackendModulesLinkPlan {
  const serverDir = Path.join(resourcesPath, "server");
  const modulesDir = Path.join(serverDir, "_modules");
  const nodeModulesPath = Path.join(serverDir, "node_modules");

  if (platform === "win32") {
    // Windows junctions must point to an absolute target.
    return {
      serverDir,
      modulesDir,
      nodeModulesPath,
      linkTarget: modulesDir,
      linkType: "junction",
    };
  }

  // macOS / Linux: use a relative symlink so the .app bundle stays relocatable.
  return {
    serverDir,
    modulesDir,
    nodeModulesPath,
    linkTarget: "_modules",
    linkType: "dir",
  };
}

export function resolvePackagedOpencodeBinaryPlan(
  platform: string,
  resourcesPath: string,
): PackagedOpencodeBinaryPlan {
  const serverDir = Path.join(resourcesPath, "server");
  const opencodeDir = Path.join(serverDir, "opencode");
  const binDir = Path.join(opencodeDir, "bin");
  const binaryName = platform === "win32" ? "opencode.exe" : "opencode";

  return {
    serverDir,
    opencodeDir,
    binDir,
    binaryName,
    binaryPath: Path.join(binDir, binaryName),
  };
}
