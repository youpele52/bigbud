/**
 * Platform detection helpers for the desktop artifact build/install pipeline.
 *
 * These are the single source of truth for early platform checks throughout the
 * install and packaging process.  Every platform-specific code path in
 * build.ts, resources.ts, and downstream scripts should delegate to these
 * helpers rather than branching on `process.platform` inline.
 */

import { type BuildPlatform } from "./shared.ts";

// ---------------------------------------------------------------------------
// Build platform type alias
// ---------------------------------------------------------------------------

export type DesktopBuildPlatform = typeof BuildPlatform.Type;

// ---------------------------------------------------------------------------
// Early platform resolution
// ---------------------------------------------------------------------------

/**
 * Converts a Node.js `process.platform` value to a `DesktopBuildPlatform`.
 * Returns `undefined` for unrecognised platforms — callers should treat this
 * as a hard failure at the entry point of the build pipeline.
 */
export function detectHostBuildPlatform(hostPlatform: string): DesktopBuildPlatform | undefined {
  if (hostPlatform === "darwin") return "mac";
  if (hostPlatform === "linux") return "linux";
  if (hostPlatform === "win32") return "win";
  return undefined;
}

/**
 * Resolves the host build platform or throws a descriptive error.
 *
 * Call this at the start of any build/install entry point so that
 * platform-specific paths are set up before any other work begins.
 */
export function resolveHostBuildPlatformOrThrow(
  hostPlatform: string = process.platform,
): DesktopBuildPlatform {
  const platform = detectHostBuildPlatform(hostPlatform);
  if (!platform) {
    throw new Error(
      `Unsupported host platform '${hostPlatform}'. ` +
        "Build must run on darwin, linux, or win32.",
    );
  }
  return platform;
}

// ---------------------------------------------------------------------------
// Narrow predicates
// ---------------------------------------------------------------------------

export function isWindowsBuildPlatform(platform: DesktopBuildPlatform): platform is "win" {
  return platform === "win";
}

export function isMacBuildPlatform(platform: DesktopBuildPlatform): platform is "mac" {
  return platform === "mac";
}

export function isLinuxBuildPlatform(platform: DesktopBuildPlatform): platform is "linux" {
  return platform === "linux";
}

export function isPosixBuildPlatform(platform: DesktopBuildPlatform): platform is "mac" | "linux" {
  return platform === "mac" || platform === "linux";
}

// ---------------------------------------------------------------------------
// Process-level platform predicates (for runtime code in scripts)
// ---------------------------------------------------------------------------

/** Whether the script is currently running on Windows. */
export function isWindowsHost(): boolean {
  return process.platform === "win32";
}

/** Whether the script is currently running on macOS. */
export function isMacHost(): boolean {
  return process.platform === "darwin";
}

/** Whether the script is currently running on a POSIX host (macOS or Linux). */
export function isPosixHost(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

// ---------------------------------------------------------------------------
// Platform-specific npm install command
// ---------------------------------------------------------------------------

/**
 * Returns the `shell` option value for `ChildProcess.spawn` on the current
 * platform.  Windows requires `shell: true` so that npm/bun can be resolved
 * via `PATH`; POSIX platforms do not need it.
 */
export function shellOptionForPlatform(platform: DesktopBuildPlatform): boolean {
  return isWindowsBuildPlatform(platform);
}
