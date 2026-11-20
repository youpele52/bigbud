import * as fs from "node:fs/promises";
import { join } from "node:path";
import {
  walkMobileRuntimeInventory,
  mobileRuntimeInventoryKey as key,
  mobileRuntimeInventoryStamp as stamp,
} from "./mobileGatewayProcess.assets.walk.ts";

export type MobileRuntimeInventory = ReadonlyMap<string, string>;
/** Fixed-size hashed path keys avoid retaining unbounded copies of long paths. */
export async function captureMobileRuntimeInventory(
  root: string,
  signal: AbortSignal,
): Promise<MobileRuntimeInventory> {
  const inventory = new Map<string, string>();
  await walkMobileRuntimeInventory(
    root,
    (entry) => {
      const path = key(entry.relative);
      if (inventory.has(path)) throw Error("Duplicate runtime entry identity.");
      inventory.set(path, entry.fingerprint);
    },
    signal,
  );
  return inventory;
}
export async function verifyMobileRuntimeInventory(
  root: string,
  inventory: MobileRuntimeInventory,
  signal?: AbortSignal,
): Promise<void> {
  const count = await walkMobileRuntimeInventory(
    root,
    (entry) => {
      if (inventory.get(key(entry.relative)) !== entry.fingerprint)
        throw Error("Foreign or substituted runtime bytes must be preserved.");
    },
    signal,
  );
  if (count !== inventory.size) throw Error("Runtime members changed; preserve their bytes.");
}

/** Remove only revalidated known leaves and empty original dirs; never recursive re-enumeration. */
export async function removeMobileRuntimeInventory(
  root: string,
  inventory: MobileRuntimeInventory,
): Promise<void> {
  const sync = await import("node:fs");
  const remove = async (relative: string): Promise<void> => {
    const path = relative ? join(root, relative) : root;
    const before = sync.lstatSync(path, { bigint: true });
    if (inventory.get(key(relative)) !== stamp(before) || sync.realpathSync(path) !== path)
      throw Error("Runtime members changed; preserve foreign bytes.");
    if (before.isDirectory()) {
      const stream = await fs.opendir(path);
      for await (const entry of stream)
        await remove(relative ? `${relative}/${entry.name}` : entry.name);
      const after = sync.lstatSync(path, { bigint: true });
      if (
        !after.isDirectory() ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.uid !== before.uid ||
        after.mode !== before.mode ||
        sync.realpathSync(path) !== path
      )
        throw Error("Runtime directory replaced during cleanup.");
      sync.rmdirSync(path); // A late extra member causes ENOTEMPTY and is preserved.
    } else if (before.isFile()) sync.unlinkSync(path);
    else throw Error("Unknown runtime member type must be preserved.");
  };
  await remove("");
}
