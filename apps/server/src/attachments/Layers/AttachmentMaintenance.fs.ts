/**
 * Filesystem steps of attachment maintenance. Every step uses `lstat`, `rename`, `link` and
 * `unlink`, which never follow a symlink in the final path component, and refuses to work under
 * a root or trash directory that is not a real directory.
 *
 * Each step is a single atomic filesystem call or is safe to repeat, so a crash between two
 * steps leaves either the original file, the trashed file, or both names for the same inode;
 * the next tick resolves all three.
 *
 * @module AttachmentMaintenance.fs
 */
import type { BigIntStats } from "node:fs";
import * as nodeFs from "node:fs/promises";
import path from "node:path";

import {
  ATTACHMENT_TRASH_DIRECTORY,
  attachmentTrashEntryName,
  SUBMISSION_UPLOAD_STAGED_FILE_NAME,
} from "../attachmentMaintenance.layout.ts";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

const isMissing = (error: unknown) => {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
};

/** Codes for filesystems without hard links, where restore falls back to a checked rename. */
const NO_HARD_LINK_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EMLINK", "ENOSYS"]);

export async function lstatIfPresent(target: string): Promise<BigIntStats | null> {
  try {
    return await nodeFs.lstat(target, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export const isRegularFile = (stats: BigIntStats | null): stats is BigIntStats =>
  stats !== null && stats.isFile() && !stats.isSymbolicLink();

/** Code-unit order, so in-memory cursors agree with the sorted listing. */
export const compareNames = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

export const sameFile = (left: BigIntStats, right: BigIntStats) =>
  left.dev === right.dev && left.ino === right.ino;

export async function readDirectoryIfRealDirectory(
  directory: string,
): Promise<"missing" | "invalid" | ReadonlyArray<string>> {
  const stats = await lstatIfPresent(directory);
  if (!stats) return "missing";
  if (!stats.isDirectory() || stats.isSymbolicLink()) return "invalid";
  try {
    return await nodeFs.readdir(directory);
  } catch (error) {
    if (isMissing(error)) return "missing";
    throw error;
  }
}

/** Creates `<root>/.trash` on first use; refuses a symlink or a non-directory in its place. */
export async function ensureTrashDirectory(root: string): Promise<string> {
  const trash = path.join(root, ATTACHMENT_TRASH_DIRECTORY);
  let stats = await lstatIfPresent(trash);
  if (!stats) {
    await nodeFs.mkdir(trash, { mode: 0o700 }).catch((error: unknown) => {
      if (errorCode(error) !== "EEXIST") throw error;
    });
    stats = await lstatIfPresent(trash);
  }
  if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("attachment_trash_invalid");
  }
  return trash;
}

export type RestoreOutcome = "restored" | "conflict";

/** Moves a trashed file back to `destination` without ever replacing a file already there. */
export async function restoreWithoutClobber(
  trashPath: string,
  destination: string,
): Promise<RestoreOutcome> {
  const trashed = await lstatIfPresent(trashPath);
  if (!isRegularFile(trashed)) return "conflict";
  try {
    await nodeFs.link(trashPath, destination);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") {
      // A crash after `link` left both names for one inode: finish the restore.
      const existing = await lstatIfPresent(destination);
      if (!existing || !sameFile(existing, trashed)) return "conflict";
    } else if (code !== undefined && NO_HARD_LINK_CODES.has(code)) {
      return renameIfFree(trashPath, destination);
    } else {
      throw error;
    }
  }
  await nodeFs.unlink(trashPath);
  return "restored";
}

async function renameIfFree(source: string, destination: string): Promise<RestoreOutcome> {
  if (await lstatIfPresent(destination)) return "conflict";
  await nodeFs.rename(source, destination);
  return "restored";
}

export type TrashMoveOutcome = "trashed" | "changed" | "collision";

/**
 * Renames `<root>/<fileName>` into the trash. If the inode that arrived is not the one that was
 * checked (the name was replaced in between), it is moved straight back.
 */
export async function moveToTrash(input: {
  readonly root: string;
  readonly trashDirectory: string;
  readonly fileName: string;
  readonly expected: BigIntStats;
  readonly nowMs: number;
}): Promise<TrashMoveOutcome> {
  const source = path.join(input.root, input.fileName);
  const target = path.join(
    input.trashDirectory,
    attachmentTrashEntryName(input.fileName, input.nowMs),
  );
  if (await lstatIfPresent(target)) return "collision";
  await nodeFs.rename(source, target);
  const moved = await lstatIfPresent(target);
  if (moved && isRegularFile(moved) && sameFile(moved, input.expected)) return "trashed";
  if (moved) await renameIfFree(target, source);
  return "changed";
}

/** Deletes a trashed regular file; anything else (symlink, directory) is left alone. */
export async function deleteTrashedFile(trashPath: string): Promise<boolean> {
  const stats = await lstatIfPresent(trashPath);
  if (!isRegularFile(stats)) return false;
  await nodeFs.unlink(trashPath);
  return true;
}

/**
 * Unlinks the staged file a crashed upload left in its staging `directory`, so the directory
 * can be removed. Only a directory holding exactly that one name, a regular file (not a
 * symlink) at least `minAgeMs` old, is touched. If publishing got as far as linking the file
 * to its destination, the destination keeps its own link. True when the file is gone.
 */
export async function removeStaleStagedUpload(
  directory: string,
  input: { readonly nowMs: number; readonly minAgeMs: number },
): Promise<boolean> {
  const entries = await readDirectoryIfRealDirectory(directory);
  if (typeof entries === "string") return false;
  if (entries.length !== 1 || entries[0] !== SUBMISSION_UPLOAD_STAGED_FILE_NAME) return false;
  const staged = path.join(directory, SUBMISSION_UPLOAD_STAGED_FILE_NAME);
  const stats = await lstatIfPresent(staged);
  if (stats === null) return true;
  if (!isRegularFile(stats)) return false;
  const changedAtMs = Math.max(Number(stats.mtimeMs), Number(stats.ctimeMs));
  if (input.nowMs - changedAtMs < input.minAgeMs) return false;
  try {
    await nodeFs.unlink(staged);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return true;
}

export type EmptyDirectoryRemoval = "removed" | "young" | "not-empty" | "not-directory" | "missing";

/**
 * Removes `target` only if it is a real directory (not a symlink), at least `minAgeMs` old by
 * its latest content or metadata change, and empty. `rmdir` is the emptiness check: it never
 * recurses, fails on a non-empty directory and does not follow a symlink swapped in after the
 * `lstat`.
 */
export async function removeEmptyDirectoryIfOld(
  target: string,
  input: {
    readonly nowMs: number;
    readonly minAgeMs: number;
    /** Tests only: runs after the `lstat` checks, right before `rmdir`. */
    readonly afterCheck?: () => Promise<void>;
  },
): Promise<EmptyDirectoryRemoval> {
  const stats = await lstatIfPresent(target);
  if (!stats) return "missing";
  if (!stats.isDirectory() || stats.isSymbolicLink()) return "not-directory";
  const changedAtMs = Math.max(Number(stats.mtimeMs), Number(stats.ctimeMs));
  if (input.nowMs - changedAtMs < input.minAgeMs) return "young";
  await input.afterCheck?.();
  try {
    await nodeFs.rmdir(target);
    return "removed";
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOTEMPTY" || code === "EEXIST") return "not-empty";
    if (code === "ENOTDIR") return "not-directory";
    if (isMissing(error)) return "missing";
    throw error;
  }
}
