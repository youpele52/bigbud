import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as sync from "node:fs";
import { createHash } from "node:crypto";
import type { OwnedMobileGatewayAssets } from "./mobileGatewayProcess.assets.ts";
import {
  mobileRuntimeInventoryStamp,
  type MobileRuntimeEntry,
} from "./mobileGatewayProcess.assets.walk.ts";
import { MOBILE_ASSET_MAX_CONTENT_BYTES } from "@bigbud/shared/mobileOptionalAssets.policy";
import {
  MOBILE_ASSETS_RECEIPT_MAX_BYTES,
  type MobileAssetsReceiptReference,
} from "./mobileGatewayAssets.receipt.reference.ts";

interface ReceiptFileState {
  readonly path: string;
  status: "writing" | "complete" | "uncertain";
  fingerprint?: string;
  reference?: MobileAssetsReceiptReference;
}
const files = new WeakMap<OwnedMobileGatewayAssets, ReceiptFileState>();
export const mobileAssetsReceiptFileState = (token: OwnedMobileGatewayAssets) => files.get(token);
export function beginMobileAssetsReceiptFile(
  token: OwnedMobileGatewayAssets,
  path: string,
): ReceiptFileState {
  if (files.has(token)) throw Error("Receipt publication was already attempted; preserve it.");
  const state: ReceiptFileState = { path, status: "writing" };
  files.set(token, state);
  return state;
}
export async function hashMobileRuntimeFile(
  entry: MobileRuntimeEntry,
  signal: AbortSignal,
  scratch = Buffer.alloc(64 * 1024),
): Promise<string> {
  signal.throwIfAborted();
  const file = await fs.open(
    entry.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (mobileRuntimeInventoryStamp(await file.stat({ bigint: true })) !== entry.fingerprint)
      throw Error("Asset changed before content hashing.");
    const hash = createHash("sha256"),
      buffer = scratch;
    let total = 0;
    while (true) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MOBILE_ASSET_MAX_CONTENT_BYTES || BigInt(total) > entry.stats.size)
        throw Error("Asset content grew during hashing.");
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (
      BigInt(total) !== entry.stats.size ||
      mobileRuntimeInventoryStamp(await file.stat({ bigint: true })) !== entry.fingerprint ||
      mobileRuntimeInventoryStamp(await fs.lstat(entry.path, { bigint: true })) !==
        entry.fingerprint ||
      (await fs.realpath(entry.path)) !== entry.path
    )
      throw Error("Asset changed during content hashing.");
    signal.throwIfAborted();
    return hash.digest("hex");
  } finally {
    await file.close();
  }
}
export async function verifyMobileAssetsReceiptFile(
  state: ReceiptFileState,
  expectedPath: string,
  signal?: AbortSignal,
): Promise<void> {
  if (
    state.path !== expectedPath ||
    state.status !== "complete" ||
    !state.reference ||
    !state.fingerprint
  )
    throw Error("Incomplete receipt ownership must be preserved.");
  signal?.throwIfAborted();
  const file = await fs.open(
    expectedPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat({ bigint: true });
    if (
      !info.isFile() ||
      info.uid !== BigInt(process.getuid?.() ?? -1) ||
      info.nlink !== 1n ||
      (info.mode & 0o7777n) !== 0o600n ||
      info.size !== BigInt(state.reference.sizeBytes) ||
      info.size > BigInt(MOBILE_ASSETS_RECEIPT_MAX_BYTES) ||
      mobileRuntimeInventoryStamp(info) !== state.fingerprint
    )
      throw Error("Receipt file was substituted; preserve bytes.");
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > state.reference.sizeBytes) throw Error("Receipt grew during verification.");
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (
      total !== state.reference.sizeBytes ||
      hash.digest("hex") !== state.reference.sha256 ||
      mobileRuntimeInventoryStamp(await file.stat({ bigint: true })) !== state.fingerprint ||
      mobileRuntimeInventoryStamp(await fs.lstat(expectedPath, { bigint: true })) !==
        state.fingerprint ||
      (await fs.realpath(expectedPath)) !== expectedPath
    )
      throw Error("Receipt changed during verification.");
  } finally {
    await file.close();
  }
}
/** Caller supplies only a computed path under the original assets token's owned namespace. */
export async function prepareMobileAssetsReceiptRemoval(
  token: OwnedMobileGatewayAssets,
  expectedPath: string,
): Promise<() => void> {
  const state = files.get(token);
  if (!state) return () => {};
  await verifyMobileAssetsReceiptFile(state, expectedPath);
  return () => {
    if (
      sync.realpathSync(expectedPath) !== expectedPath ||
      mobileRuntimeInventoryStamp(sync.lstatSync(expectedPath, { bigint: true })) !==
        state.fingerprint
    )
      throw Error("Foreign receipt must be preserved.");
    sync.unlinkSync(expectedPath);
    files.delete(token);
  };
}
