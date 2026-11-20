import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  MOBILE_ASSET_MAX_ENTRIES,
  MOBILE_ASSET_MAX_CONTENT_BYTES,
  validateMobileAssetPath,
} from "@bigbud/shared/mobileOptionalAssets.policy";
import { assertLocalSupervisorServiceDirectory } from "./localSupervisorService.files.ts";
export interface MobileRuntimeEntry {
  readonly relative: string;
  readonly path: string;
  readonly directory: boolean;
  readonly stats: BigIntStats;
  readonly fingerprint: string;
}
export const mobileRuntimeInventoryKey = (path: string) =>
  createHash("sha256").update("bigbud.mobile-runtime-entry.v1\0").update(path).digest("hex");
export function mobileRuntimeInventoryStamp(info: BigIntStats): string {
  return [
    info.dev,
    info.ino,
    info.mode,
    info.uid,
    info.gid,
    info.nlink,
    info.size,
    info.mtimeNs,
    info.ctimeNs,
  ].join(":");
}
export async function walkMobileRuntimeInventory(
  root: string,
  visit: (entry: MobileRuntimeEntry) => void | Promise<void>,
  signal?: AbortSignal,
) {
  let entries = 0,
    bytes = 0;
  const traverse = async (relative: string): Promise<void> => {
    signal?.throwIfAborted();
    const path = relative ? join(root, relative) : root;
    const before = await fs.lstat(path, { bigint: true });
    const directory = before.isDirectory();
    if (relative) validateMobileAssetPath(relative, directory);
    if (
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      (!directory && !before.isFile()) ||
      (before.mode & 0o7777n) !== BigInt(directory ? 0o700 : 0o600) ||
      (!directory && before.nlink !== 1n)
    )
      throw Error("Runtime assets changed ownership/type/permissions; preserve them.");
    if (++entries > MOBILE_ASSET_MAX_ENTRIES + 1)
      throw Error("Runtime inventory entry budget exceeded.");
    if (!directory) {
      bytes += Number(before.size);
      if (bytes > MOBILE_ASSET_MAX_CONTENT_BYTES)
        throw Error("Runtime inventory byte budget exceeded.");
    }
    await visit({
      relative,
      path,
      directory,
      stats: before,
      fingerprint: mobileRuntimeInventoryStamp(before),
    });
    if (directory) {
      const stream = await fs.opendir(path);
      for await (const entry of stream)
        await traverse(relative ? `${relative}/${entry.name}` : entry.name);
    }
    if (
      mobileRuntimeInventoryStamp(before) !==
      mobileRuntimeInventoryStamp(await fs.lstat(path, { bigint: true }))
    )
      throw Error("Runtime assets changed during ownership check.");
  };
  await assertLocalSupervisorServiceDirectory(root);
  await traverse("");
  signal?.throwIfAborted();
  return entries;
}
