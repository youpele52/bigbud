import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Bounded include-file helpers for the profile alias resolver: glob expansion
 * of trailing segments and the owner-private file check.
 *
 * @module sshConfigProfileAliases.files
 */

export const PROFILE_ALIAS_MAX_FILES = 64;
export const PROFILE_ALIAS_MAX_FILE_BYTES = 256 * 1024;

const invalidProfileFile = () =>
  new Error("Expected an owner-private SSH config inside the disposable profile.");

function hasGlob(pattern: string): boolean {
  return /[*?]/u.test(pattern);
}

function globToRegExp(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`, "u");
}

/** Expands `*`/`?` in trailing path segments, sorted like glob(3). */
export async function expandInclude(pattern: string): Promise<ReadonlyArray<string>> {
  if (!hasGlob(pattern)) return [pattern];
  const { root } = path.parse(pattern);
  const segments = pattern
    .slice(root.length)
    .split(/[\\/]+/u)
    .filter((segment) => segment.length > 0);
  let candidates = [root];
  for (const segment of segments) {
    const next: string[] = [];
    for (const directory of candidates) {
      if (!hasGlob(segment)) {
        next.push(path.join(directory, segment));
        continue;
      }
      const entries = await readdir(directory).catch(() => [] as string[]);
      const matcher = globToRegExp(segment);
      for (const name of entries.toSorted()) {
        if (name.startsWith(".") && !segment.startsWith(".")) continue;
        if (matcher.test(name)) next.push(path.join(directory, name));
      }
    }
    candidates = next.slice(0, PROFILE_ALIAS_MAX_FILES);
  }
  return candidates;
}

export async function assertPrivateFile(root: string, filePath: string): Promise<string> {
  const info = await lstat(filePath);
  const uid = process.getuid?.();
  if (
    !info.isFile() ||
    (uid !== undefined && info.uid !== uid) ||
    (info.mode & 0o077) !== 0 ||
    info.size > PROFILE_ALIAS_MAX_FILE_BYTES
  )
    throw invalidProfileFile();
  const real = await realpath(filePath);
  const relative = path.relative(root, real);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative))
    throw invalidProfileFile();
  return real;
}

/**
 * U17 production Include: a regular file (after resolving links) owned by this account or root,
 * bounded, and writable by no other account, in a directory chain no other account can modify
 * (a root-owned sticky directory such as `/tmp` is allowed). Readability by others is fine: an
 * SSH config is not a secret, and only a writer could change the route.
 */
export async function assertSafeReadableFile(filePath: string): Promise<string> {
  const real = await realpath(filePath);
  const uid = process.getuid?.();
  const trusted = (owner: number) => uid === undefined || owner === uid || owner === 0;
  const info = await lstat(real);
  if (
    !info.isFile() ||
    !trusted(info.uid) ||
    (info.mode & 0o022) !== 0 ||
    info.size > PROFILE_ALIAS_MAX_FILE_BYTES
  )
    throw invalidProfileFile();
  for (let directory = path.dirname(real); ; directory = path.dirname(directory)) {
    const parent = await lstat(directory);
    const sticky = parent.uid === 0 && (parent.mode & 0o1000) !== 0;
    if (!parent.isDirectory() || !trusted(parent.uid) || ((parent.mode & 0o022) !== 0 && !sticky))
      throw invalidProfileFile();
    if (path.dirname(directory) === directory) return real;
  }
}
