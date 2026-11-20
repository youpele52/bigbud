import { lstat, mkdir, opendir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MOBILE_ASSET_MAX_CONTENT_BYTES,
  MOBILE_ASSET_MAX_DIRECTORY_DEPTH,
  MOBILE_ASSET_MAX_ENTRIES,
  claimMobileAssetPath,
} from "@bigbud/shared/mobileOptionalAssets.policy";
import type { ClosureEntry } from "./lib/remote-backend-control/closure.ts";
import { fingerprint, readStableFile } from "./lib/artifact-build/io.ts";

export interface CapturedMobileAssets {
  readonly entries: readonly ClosureEntry[];
  readonly identities: ReadonlyMap<string, string>;
}

/** Static build output only. Unknown files fail rather than silently shipping extra material. */
export async function captureMobileAssets(
  root: string,
  destination: string,
): Promise<CapturedMobileAssets> {
  const entries: ClosureEntry[] = [];
  const identities = new Map<string, string>();
  const foldedPaths = new Set<string>();
  let totalBytes = 0;
  async function visit(directory: string, relative: string, depth: number): Promise<void> {
    if (depth > MOBILE_ASSET_MAX_DIRECTORY_DEPTH) throw new Error("Asset depth budget exceeded.");
    const before = await lstat(directory);
    if (!before.isDirectory()) throw new Error("Assets directory must be a real directory.");
    identities.set(directory, fingerprint(before));
    const children: string[] = [];
    const stream = await opendir(directory);
    for await (const child of stream) {
      if (children.length + entries.length >= MOBILE_ASSET_MAX_ENTRIES)
        throw new Error("Asset entry budget exceeded.");
      children.push(child.name);
    }
    for (const name of children.toSorted()) {
      const path = relative ? `${relative}/${name}` : name;
      const source = join(directory, name);
      const snapshot = join(destination, path);
      const info = await lstat(source);
      claimMobileAssetPath(path, info.isDirectory(), foldedPaths);
      if (entries.length >= MOBILE_ASSET_MAX_ENTRIES)
        throw new Error("Asset entry budget exceeded.");
      if (info.isDirectory()) {
        entries.push({ path, kind: "directory", mode: 0o755 });
        await mkdir(snapshot, { mode: 0o700 });
        await visit(source, path, depth + 1);
      } else if (info.isFile() && info.nlink === 1) {
        if (info.size + totalBytes > MOBILE_ASSET_MAX_CONTENT_BYTES)
          throw new Error("Asset byte budget exceeded.");
        const captured = await readStableFile(source);
        if (
          captured.bytes.includes(Buffer.from("-----BEGIN ")) ||
          captured.bytes.includes(Buffer.from("PRIVATE KEY-----"))
        ) {
          throw new Error("Credential/key material is forbidden in assets.");
        }
        totalBytes += captured.bytes.length;
        if (totalBytes > MOBILE_ASSET_MAX_CONTENT_BYTES)
          throw new Error("Asset byte budget exceeded.");
        await writeFile(snapshot, captured.bytes, { flag: "wx", mode: 0o600 });
        identities.set(source, captured.identity);
        entries.push({
          path,
          kind: "file",
          mode: 0o644,
          size: captured.bytes.length,
          sha256: captured.sha256,
          source: snapshot,
        });
      } else throw new Error("Assets contain a link, special file or unsupported static file.");
    }
    if (fingerprint(await lstat(directory)) !== fingerprint(before))
      throw new Error("Assets changed during capture.");
  }
  await visit(root, "", 0);
  if (!entries.some((entry) => entry.path === "index.html" && entry.kind === "file")) {
    throw new Error("Assets require a static index.html entry point.");
  }
  return { entries, identities };
}

export async function assertMobileAssetsStable(
  root: string,
  captured: CapturedMobileAssets,
): Promise<void> {
  for (const [path, identity] of captured.identities) {
    if (fingerprint(await lstat(path)) !== identity)
      throw new Error("Assets changed before signing.");
  }
  for (const entry of captured.entries) {
    if (entry.kind !== "file") continue;
    const read = await readStableFile(join(root, entry.path));
    if (
      read.sha256 !== entry.sha256 ||
      read.identity !== captured.identities.get(join(root, entry.path))
    ) {
      throw new Error("Assets content changed before signing.");
    }
  }
  // Recheck earlier entries/directories after the complete final hash walk.
  for (const [path, identity] of captured.identities) {
    if (fingerprint(await lstat(path)) !== identity)
      throw new Error("Assets changed during final verification.");
  }
}
