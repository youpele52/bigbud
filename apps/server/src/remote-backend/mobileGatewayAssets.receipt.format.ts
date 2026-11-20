import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import {
  MOBILE_ASSET_MAX_CONTENT_BYTES,
  MOBILE_ASSET_MAX_ENTRIES,
} from "@bigbud/shared/mobileOptionalAssets.policy";
import { MOBILE_ASSETS_RECEIPT_MAX_BYTES } from "./mobileGatewayAssets.receipt.reference.ts";
import {
  MobileAssetsReceipt,
  type MobileAssetsDirectoryAnchor,
  type MobileAssetsEntryStat,
} from "./mobileGatewayAssets.receipt.schema.ts";

/** Exact raw UTF8: no slash, Unicode or case normalization. Actual walks separately enforce policy. */
export function mobileAssetsReceiptPathDigest(
  relative: string,
  kind: "directory" | "file",
): string {
  return createHash("sha256")
    .update("bigbud.mobile-native-assets-entry.v1\0")
    .update(kind)
    .update("\0")
    .update(relative, "utf8")
    .digest("hex");
}
const canonicalAnchor = (a: MobileAssetsDirectoryAnchor) => ({
  dev: a.dev,
  ino: a.ino,
  uid: a.uid,
  gid: a.gid,
  mode: a.mode,
});
const canonicalStat = (s: MobileAssetsEntryStat) => ({
  ...canonicalAnchor(s),
  nlink: s.nlink,
  size: s.size,
  mtimeNs: s.mtimeNs,
  ctimeNs: s.ctimeNs,
});
function validateNumbers(stat: MobileAssetsDirectoryAnchor | MobileAssetsEntryStat) {
  for (const value of Object.values(stat))
    if (BigInt(value) > 0xffffffffffffffffn) throw Error("Receipt stat exceeds native u64.");
}
export function canonicalMobileAssetsReceipt(input: unknown): Buffer {
  if (
    typeof input === "object" &&
    input !== null &&
    "entries" in input &&
    Array.isArray(input.entries) &&
    input.entries.length > MOBILE_ASSET_MAX_ENTRIES + 1
  )
    throw Error("Receipt entry bound exceeded.");
  const r = Schema.decodeUnknownSync(MobileAssetsReceipt)(input, { onExcessProperty: "error" });
  if (
    !Number.isSafeInteger(r.owner.authority.keyEpoch) ||
    r.entries.length < 1 ||
    r.entries.length > MOBILE_ASSET_MAX_ENTRIES + 1
  )
    throw Error("Receipt identity or entry bound exceeded.");
  for (const anchor of Object.values(r.anchors)) {
    validateNumbers(anchor);
    if (anchor.uid !== r.anchors.state.uid) throw Error("Receipt anchor owner mismatch.");
    if (BigInt(anchor.mode) !== 0o40700n) throw Error("Private directory anchor required.");
  }
  const entries = r.entries.toSorted((a, b) =>
    a.pathDigest < b.pathDigest ? -1 : a.pathDigest > b.pathDigest ? 1 : 0,
  );
  let bytes = 0,
    root = false;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.pathDigest)) throw Error("Duplicate receipt entry digest.");
    seen.add(entry.pathDigest);
    validateNumbers(entry.stat);
    if (entry.stat.uid !== r.anchors.root.uid) throw Error("Receipt entry owner mismatch.");
    if (BigInt(entry.stat.mode) !== (entry.kind === "directory" ? 0o40700n : 0o100600n))
      throw Error("Receipt type/private mode mismatch.");
    if (entry.kind === "file") {
      if (entry.stat.nlink !== "1") throw Error("Private single-link receipt file required.");
      bytes += Number(entry.stat.size);
    }
    if (entry.pathDigest === mobileAssetsReceiptPathDigest("", "directory")) {
      if (
        entry.kind !== "directory" ||
        JSON.stringify(canonicalAnchor(entry.stat)) !==
          JSON.stringify(canonicalAnchor(r.anchors.root))
      )
        throw Error("Receipt root anchor mismatch.");
      root = true;
    }
  }
  if (!root || bytes > MOBILE_ASSET_MAX_CONTENT_BYTES || bytes !== r.contentBytes)
    throw Error("Receipt root/content bound mismatch.");
  const canonical = {
    schemaVersion: r.schemaVersion,
    kind: r.kind,
    namespace: r.namespace,
    generation: r.generation,
    owner: {
      authority: {
        authorityId: r.owner.authority.authorityId,
        keyFingerprint: r.owner.authority.keyFingerprint,
        keyEpoch: r.owner.authority.keyEpoch,
      },
      installationFingerprint: r.owner.installationFingerprint,
    },
    controller: { id: r.controller.id, pid: r.controller.pid, startedAt: r.controller.startedAt },
    controllerHost: { hostname: r.controllerHost.hostname, machineId: r.controllerHost.machineId },
    publication: {
      stageId: r.publication.stageId,
      releaseId: r.publication.releaseId,
      consentRevision: r.publication.consentRevision,
      preparationNonce: r.publication.preparationNonce,
      archiveSha256: r.publication.archiveSha256,
    },
    anchors: {
      state: canonicalAnchor(r.anchors.state),
      namespace: canonicalAnchor(r.anchors.namespace),
      root: canonicalAnchor(r.anchors.root),
    },
    contentBytes: r.contentBytes,
    entries: entries.map((entry) =>
      entry.kind === "directory"
        ? { kind: entry.kind, pathDigest: entry.pathDigest, stat: canonicalStat(entry.stat) }
        : {
            kind: entry.kind,
            pathDigest: entry.pathDigest,
            stat: canonicalStat(entry.stat),
            sha256: entry.sha256,
          },
    ),
  };
  const bytesOut = Buffer.from(JSON.stringify(canonical), "utf8");
  if (bytesOut.length > MOBILE_ASSETS_RECEIPT_MAX_BYTES)
    throw Error("Receipt byte bound exceeded.");
  return bytesOut;
}
