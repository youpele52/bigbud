import { lstat } from "node:fs/promises";
import path from "node:path";

/** Root/current-user nonmutable namespaces prevent foreign-UID ancestor replacement; root-owned sticky temp roots are safe exceptions. */
export async function assertV2ThreadStorageAncestors(directory: string) {
  if (process.platform === "win32") return; // Windows file/root privacy is checked by the existing DACL/no-reparse helper.
  const uid = process.getuid?.();
  let current = path.resolve(directory);
  for (;;) {
    const info = await lstat(current);
    const trustedOwner = info.uid === 0 || info.uid === uid;
    const stickyRoot = info.uid === 0 && Boolean(info.mode & 0o1000);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      !trustedOwner ||
      (info.mode & 0o022 && !stickyRoot)
    )
      throw new Error("V2 thread-tools storage canonical ancestor namespace is unsafe.");
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
