import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import golden from "../../../../packages/shared/src/mobileOptionalAssets/fixtures/native-receipt-v1.json" with { type: "json" };
import {
  canonicalMobileAssetsReceipt,
  mobileAssetsReceiptPathDigest,
} from "./mobileGatewayAssets.receipt.format.ts";
import { validateMobileAssetPath } from "@bigbud/shared/mobileOptionalAssets.policy";

it("pins exact shared UTF8 path digests including root, nesting, Unicode and kind", () => {
  for (const vector of golden.vectors) {
    if (vector.kind !== "file" && vector.kind !== "directory")
      throw Error("Bad shared vector kind.");
    expect(mobileAssetsReceiptPathDigest(vector.relative, vector.kind)).toBe(vector.digest);
  }
  expect(new Set(golden.vectors.map((vector) => vector.digest)).size).toBe(golden.vectors.length);
  // Hash encoding has no Unicode normalization; actual static-tree policy remains unchanged.
  expect(() => validateMobileAssetPath("café/app.js", false)).toThrow(/Unsafe/);
});
it("pins canonical property ordering, entry ordering, exact bytes and plain file SHA", () => {
  const bytes = canonicalMobileAssetsReceipt({
    ...golden.receipt,
    entries: golden.receipt.entries.toReversed(),
  });
  expect(bytes.toString("utf8")).toBe(golden.canonicalUtf8);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(golden.sha256);
});
it("rejects missing root, duplicate entries, unknown future metadata and cross-kind stat replay", () => {
  const receipt = golden.receipt;
  expect(() =>
    canonicalMobileAssetsReceipt({
      ...receipt,
      entries: receipt.entries.filter((entry) => entry.kind === "file"),
    }),
  ).toThrow(/root/);
  expect(() =>
    canonicalMobileAssetsReceipt({ ...receipt, entries: [...receipt.entries, receipt.entries[0]] }),
  ).toThrow(/Duplicate/);
  expect(() => canonicalMobileAssetsReceipt({ ...receipt, nativeReady: true })).toThrow();
  expect(() =>
    canonicalMobileAssetsReceipt({
      ...receipt,
      entries: receipt.entries.map((entry) =>
        entry.kind === "file"
          ? Object.assign({}, entry, { stat: Object.assign({}, entry.stat, { mode: "16832" }) })
          : entry,
      ),
    }),
  ).toThrow(/mode/);
});
it("fails closed on row count, unsafe numeric fingerprints, owner changes and content mismatch", () => {
  const receipt = golden.receipt;
  expect(() =>
    canonicalMobileAssetsReceipt({ ...receipt, entries: Array(16_386).fill(receipt.entries[0]) }),
  ).toThrow(/entry bound/);
  expect(() =>
    canonicalMobileAssetsReceipt({
      ...receipt,
      anchors: {
        ...receipt.anchors,
        state: { ...receipt.anchors.state, ino: "18446744073709551616" },
      },
    }),
  ).toThrow(/u64/);
  expect(() =>
    canonicalMobileAssetsReceipt({
      ...receipt,
      anchors: { ...receipt.anchors, namespace: { ...receipt.anchors.namespace, uid: "999" } },
    }),
  ).toThrow(/owner/);
  expect(() => canonicalMobileAssetsReceipt({ ...receipt, contentBytes: 6 })).toThrow(/content/);
});
