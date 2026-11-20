/**
 * Validation for handing a local path to the OS default handler (open or reveal).
 * Shared by every entry point that calls into the OS so the rules cannot drift.
 */
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as nodePath from "node:path";

import { isAbsolutePath, isWindowsAbsolutePath } from "./path";
import { isOsIndexExcludedPath } from "./search/osIndexExclusions";
import {
  EXECUTABLE_MAGIC_BYTES,
  hasExecutableMagic,
  hasLaunchableDirectoryExtension,
  hasLaunchableFileExtension,
} from "./systemOpenPath.launchable";

/** Linux PATH_MAX; longer inputs are refused before touching the file system. */
const MAX_SYSTEM_OPEN_PATH_LENGTH = 4096;

export type SystemOpenPathRefusal =
  /** Not a string, empty, relative, contains NUL, or a UNC/device path on Windows. */
  | "invalid-path"
  | "not-found"
  /**
   * Exists but cannot be resolved or inspected (permissions, loops), or is protected by the
   * shared privacy exclusions (`.ssh`, keychains, browser profiles, `.env`, private keys).
   */
  | "inaccessible"
  /** Neither a regular file nor a directory (socket, FIFO, device). */
  | "unsupported-entry";

export type SystemOpenPathInspection =
  | {
      readonly ok: true;
      /** Symlink-free path to hand to the OS. */
      readonly realPath: string;
      readonly kind: "file" | "directory";
      /** Runs, installs or mounts when opened: reveal it, never open it. */
      readonly launchable: boolean;
    }
  | { readonly ok: false; readonly reason: SystemOpenPathRefusal };

/**
 * Normalised absolute path, or `null` when the input is unusable on `platform`. Windows refuses
 * UNC and `\\?\` / `\\.\` device paths (network credential prompts, raw devices) and
 * drive-relative `/x` paths; POSIX refuses Windows-style paths.
 */
export function normalizeSystemOpenPath(raw: unknown, platform: NodeJS.Platform): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_SYSTEM_OPEN_PATH_LENGTH) {
    return null;
  }
  if (raw.includes("\0") || !isAbsolutePath(raw)) return null;
  if (platform === "win32") {
    if (!isWindowsAbsolutePath(raw) || raw.startsWith("\\\\")) return null;
    return nodePath.win32.normalize(raw);
  }
  return raw.startsWith("/") ? nodePath.posix.normalize(raw) : null;
}

function refusalForError(error: unknown): SystemOpenPathRefusal {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" ? "not-found" : "inaccessible";
}

/** Unreadable headers count as executable: the safe outcome is a reveal. */
async function hasExecutableHeader(realPath: string): Promise<boolean> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(realPath, "r");
    const header = new Uint8Array(EXECUTABLE_MAGIC_BYTES);
    const { bytesRead } = await handle.read(header, 0, EXECUTABLE_MAGIC_BYTES, 0);
    return hasExecutableMagic(header.subarray(0, bytesRead));
  } catch {
    return true;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Validates `raw` for system open: absolute, existing, symlinks resolved, then re-checked as a
 * regular file or directory. Paths on the shared exclusion list (by requested or real path) are
 * refused. Launchable when either the requested or the real name has a launchable extension, or
 * (files only) the POSIX execute bit is set or the header is an executable or `#!` script.
 */
export async function inspectSystemOpenPath(
  raw: unknown,
  platform: NodeJS.Platform = process.platform,
  options: { readonly home?: string } = {},
): Promise<SystemOpenPathInspection> {
  const requestedPath = normalizeSystemOpenPath(raw, platform);
  if (requestedPath === null) return { ok: false, reason: "invalid-path" };

  let realPath: string;
  let stats: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    realPath = await fs.realpath(requestedPath);
    stats = await fs.lstat(realPath);
  } catch (error) {
    return { ok: false, reason: refusalForError(error) };
  }
  const home = options.home ?? homedir();
  if (isOsIndexExcludedPath(requestedPath, home) || isOsIndexExcludedPath(realPath, home)) {
    return { ok: false, reason: "inaccessible" };
  }

  if (stats.isDirectory()) {
    const launchable =
      hasLaunchableDirectoryExtension(requestedPath) || hasLaunchableDirectoryExtension(realPath);
    return { ok: true, realPath, kind: "directory", launchable };
  }
  if (!stats.isFile()) return { ok: false, reason: "unsupported-entry" };

  const launchable =
    hasLaunchableFileExtension(requestedPath) ||
    hasLaunchableFileExtension(realPath) ||
    (platform !== "win32" && (stats.mode & 0o111) !== 0) ||
    (await hasExecutableHeader(realPath));
  return { ok: true, realPath, kind: "file", launchable };
}
