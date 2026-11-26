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
