import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import type { VerifiedMobilePublication } from "../remote-agent/mobileOptionalPublication.ts";
import { syncDirectory } from "../remote-agent/mobileOptionalPublication.files.ts";
import {
  type OwnedMobileGatewayAssets,
  withOriginalMobileGatewayAssets,
  beginMobileGatewayAssetsReceiptWrite,
} from "./mobileGatewayProcess.assets.ts";
import {
  mobileRuntimeInventoryStamp,
  walkMobileRuntimeInventory,
} from "./mobileGatewayProcess.assets.walk.ts";
import {
  beginMobileAssetsReceiptFile,
  mobileAssetsReceiptFileState,
  hashMobileRuntimeFile,
  verifyMobileAssetsReceiptFile,
} from "./mobileGatewayAssets.receipt.files.ts";
import {
  canonicalMobileAssetsReceipt,
  mobileAssetsReceiptPathDigest,
} from "./mobileGatewayAssets.receipt.format.ts";
import {
  type MobileAssetsDirectoryAnchor,
  type MobileAssetsEntryStat,
  type MobileAssetsReceiptEntry,
} from "./mobileGatewayAssets.receipt.schema.ts";
import {
  MOBILE_GATEWAY_RUNTIME_NAMESPACE,
  MOBILE_ASSETS_RECEIPT_MAX_BYTES,
  type MobileAssetsReceiptReference,
} from "./mobileGatewayAssets.receipt.reference.ts";

export const mobileAssetsDirectoryAnchor = (info: BigIntStats): MobileAssetsDirectoryAnchor => ({
  dev: info.dev.toString(),
  ino: info.ino.toString(),
  uid: info.uid.toString(),
  gid: info.gid.toString(),
  mode: info.mode.toString(),
});
const entryStat = (info: BigIntStats): MobileAssetsEntryStat => ({
  ...mobileAssetsDirectoryAnchor(info),
  nlink: info.nlink.toString(),
  size: info.size.toString(),
  mtimeNs: info.mtimeNs.toString(),
  ctimeNs: info.ctimeNs.toString(),
});

/** Returns mechanical reference DATA, never native approval; original capability remains required. */
export async function writeMobileGatewayAssetsReceipt(
  proof: VerifiedMobilePublication,
  token: OwnedMobileGatewayAssets,
  external?: AbortSignal,
): Promise<MobileAssetsReceiptReference> {
  const settled = beginMobileGatewayAssetsReceiptWrite(token);
  return withOriginalMobileGatewayAssets(
    proof,
    token,
    async (data, publication, signal, assertCurrent) => {
      const path = `${data.path}.receipt.json`,
        prior = mobileAssetsReceiptFileState(token);
      if (prior) {
        await verifyMobileAssetsReceiptFile(prior, path, signal);
        if (!prior.reference) throw Error("Original receipt reference unavailable.");
        return prior.reference;
      }
      if (data.transferArmed)
        throw Error("Native transfer armed; new receipt cannot be published.");
      const entries: MobileAssetsReceiptEntry[] = [];
      const scratch = Buffer.alloc(64 * 1024);
      let contentBytes = 0,
        retainedBytes = 0;
      await walkMobileRuntimeInventory(
        data.path,
        async (entry) => {
          const stat = entryStat(entry.stats),
            kind = entry.directory ? "directory" : "file";
          const pathDigest = mobileAssetsReceiptPathDigest(entry.relative, kind);
          const record: MobileAssetsReceiptEntry = entry.directory
            ? { kind: "directory", pathDigest, stat }
            : {
                kind: "file",
                pathDigest,
                stat,
                sha256: await hashMobileRuntimeFile(entry, signal, scratch),
              };
          retainedBytes += Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
          if (retainedBytes > MOBILE_ASSETS_RECEIPT_MAX_BYTES - 16 * 1024)
            throw Error("Receipt retention budget exceeded.");
          entries.push(record);
          if (!entry.directory) contentBytes += Number(entry.stats.size);
        },
        signal,
      );
      await assertCurrent();
      const bytes = canonicalMobileAssetsReceipt({
        schemaVersion: 1,
        kind: "mobile-native-assets",
        namespace: MOBILE_GATEWAY_RUNTIME_NAMESPACE,
        generation: basename(data.path),
        owner: publication.paths.owner,
        controller: publication.authority.controller,
        controllerHost: {
          hostname: publication.authority.owner.hostname,
          machineId: publication.authority.owner.machineId,
        },
        publication: {
          stageId: data.stageId,
          releaseId: data.releaseId,
          consentRevision: data.consentRevision,
          preparationNonce: data.nonce,
          archiveSha256: publication.paths.assetsArtifact.sha256,
        },
        anchors: {
          state: mobileAssetsDirectoryAnchor(await fs.lstat(data.stateDir, { bigint: true })),
          namespace: mobileAssetsDirectoryAnchor(await fs.lstat(data.parent, { bigint: true })),
          root: mobileAssetsDirectoryAnchor(await fs.lstat(data.path, { bigint: true })),
        },
        contentBytes,
        entries,
      });
      const reference: MobileAssetsReceiptReference = Object.freeze({
        schemaVersion: 1,
        generation: basename(data.path),
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      const state = beginMobileAssetsReceiptFile(token, path);
      try {
        signal.throwIfAborted();
        const file = await fs.open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(bytes);
          await file.sync();
          state.fingerprint = mobileRuntimeInventoryStamp(await file.stat({ bigint: true }));
        } finally {
          await file.close();
        }
        await syncDirectory(data.parent);
        // File ownership is known independently of later admission cancellation, enabling safe teardown.
        state.reference = reference;
        state.status = "complete";
        await verifyMobileAssetsReceiptFile(state, path, signal);
        await assertCurrent();
        return reference;
      } catch (cause) {
        if (state.status !== "complete") state.status = "uncertain";
        throw cause;
      }
    },
    external,
  ).finally(settled);
}
