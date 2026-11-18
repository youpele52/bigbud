import * as fs from "node:fs";
import { dirname } from "node:path";
import type { Stats } from "node:fs";

export const mobileAssetIdentity = (info: Stats) => `${info.dev}:${info.ino}`;
export const mobileAssetFileFingerprint = (info: Stats) =>
  [
    info.dev,
    info.ino,
    info.size,
    info.mode,
    info.uid,
    info.gid,
    info.nlink,
    info.mtimeMs,
    info.ctimeMs,
  ].join(":");
export interface MobileAssetOwnedFile {
  readonly identity: string;
  completedFingerprint?: string;
}
function ownedDirectory(path: string, expected: string) {
  const info = fs.lstatSync(path);
  return (
    info.isDirectory() &&
    info.uid === process.getuid?.() &&
    (info.mode & 0o7777) === 0o700 &&
    mobileAssetIdentity(info) === expected &&
    fs.realpathSync(path) === path
  );
}
/** Best-effort rollback of known leaves/empty dirs only; unknown or changed contents always remain. */
export function cleanupOwnedMobileAssetTree(
  directories: ReadonlyMap<string, string>,
  files: ReadonlyMap<string, MobileAssetOwnedFile>,
): void {
  const parents = (path: string) => {
    for (let current = dirname(path); directories.has(current); current = dirname(current))
      if (!ownedDirectory(current, directories.get(current)!)) return false;
    return true;
  };
  for (const [path, record] of files) {
    if (record.completedFingerprint === undefined) continue; // Incomplete leaves may contain untracked in-place edits.
    try {
      if (!parents(path)) continue;
      const info = fs.lstatSync(path);
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o7777) !== 0o600 ||
        info.nlink !== 1 ||
        mobileAssetIdentity(info) !== record.identity ||
        (record.completedFingerprint !== undefined &&
          mobileAssetFileFingerprint(info) !== record.completedFingerprint) ||
        fs.realpathSync(path) !== path
      )
        continue;
      fs.unlinkSync(path);
    } catch {
      /* Preserve ambiguous/replaced paths; never recursively delete them. */
    }
  }
  const ordered = [...directories].toSorted((a, b) => b[0].length - a[0].length);
  for (const [path, expected] of ordered) {
    try {
      if (parents(path) && ownedDirectory(path, expected)) fs.rmdirSync(path);
    } catch {
      /* A new foreign member keeps its directory intact. */
    }
  }
}
