import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { V2_NATIVE_QUALIFICATION_SCOPES } from "./NativeCompatibility.types.ts";
import { syntheticV2QualificationRecord } from "./NativeCompatibility.qualification.fixture.ts";
import { prepareV2NativeQualificationRecord } from "./NativeCompatibility.evidence.ts";

function syntheticPacket() {
  const record = syntheticV2QualificationRecord(),
    review = {
      status: "passed",
      reviewer: "ses_SyntheticOnly",
      sourceSnapshotDigest: record.sourceSnapshotDigest,
    };
  const results = Object.fromEntries(
    V2_NATIVE_QUALIFICATION_SCOPES.map((scope) => [
      scope,
      {
        status: "passed",
        tests: 1,
        failures: 0,
        skipped: 0,
        nativeVersion: record.nativeVersion,
        testedBinarySha256: record.testedBinarySha256,
        sourceSnapshotDigest: record.sourceSnapshotDigest,
        environmentEvidenceDigest: record.environmentEvidenceDigest,
        outputDigest: "a".repeat(64),
      },
    ]),
  );
  record.resultsDigest = createHash("sha256")
    .update(JSON.stringify(V2_NATIVE_QUALIFICATION_SCOPES.map((scope) => [scope, results[scope]])))
    .digest("hex");
  return {
    format: "bigbud.thread.native-qualification.evidence.v1",
    record,
    binaryBefore: record.testedBinarySha256,
    binaryAfter: record.testedBinarySha256,
    reviews: {
      code: { ...review, reviewer: "ses_SyntheticCode" },
      security: { ...review, reviewer: "ses_SyntheticSecurity" },
      requirements: { ...review, reviewer: "ses_SyntheticRequirements" },
    },
    results,
  };
}

it("offline synthetic evidence tests preparation mechanics only, never populate a native pass registry", () => {
  expect(prepareV2NativeQualificationRecord(syntheticPacket()).suiteRevision).toBe(
    "synthetic-not-native-qualification",
  );
});

it.each(V2_NATIVE_QUALIFICATION_SCOPES)(
  "partial/skipped %s cannot prepare a completed record",
  (scope) => {
    const packet = syntheticPacket();
    packet.results[scope]!.skipped = 1;
    expect(() => prepareV2NativeQualificationRecord(packet)).toThrow();
  },
);

it("changed image, wrong source review or swapped environment cannot promote matching version strings", () => {
  const packet = syntheticPacket();
  packet.binaryAfter = "f".repeat(64);
  expect(() => prepareV2NativeQualificationRecord(packet)).toThrow("image/source/review identity");
  const wrong = syntheticPacket();
  wrong.reviews.code = { ...wrong.reviews.code, sourceSnapshotDigest: "a".repeat(64) };
  expect(() => prepareV2NativeQualificationRecord(wrong)).toThrow("image/source/review identity");
  const swapped = syntheticPacket();
  swapped.results["isolation-hooks"]!.environmentEvidenceDigest = "b".repeat(64);
  expect(() => prepareV2NativeQualificationRecord(swapped)).toThrow(
    "another source/image/environment",
  );
});
