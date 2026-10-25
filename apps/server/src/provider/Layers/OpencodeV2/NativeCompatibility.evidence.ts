import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import {
  V2NativeQualificationRecord,
  V2_NATIVE_QUALIFICATION_SCOPES,
} from "./NativeCompatibility.types.ts";
import { validateV2NativeQualificationRegistry } from "./NativeCompatibility.qualification.ts";

const Hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Review = Schema.Struct({
  status: Schema.Literal("passed"),
  reviewer: Schema.String.check(Schema.isPattern(/^ses_[A-Za-z0-9]{1,100}$/)),
  sourceSnapshotDigest: Hex,
});
const Scope = Schema.Struct({
  status: Schema.Literal("passed"),
  tests: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  failures: Schema.Literal(0),
  skipped: Schema.Literal(0),
  nativeVersion: Schema.String,
  testedBinarySha256: Hex,
  sourceSnapshotDigest: Hex,
  environmentEvidenceDigest: Hex,
  outputDigest: Hex,
});
export const V2NativeQualificationEvidence = Schema.Struct({
  format: Schema.Literal("bigbud.thread.native-qualification.evidence.v1"),
  record: V2NativeQualificationRecord,
  binaryBefore: Hex,
  binaryAfter: Hex,
  reviews: Schema.Struct({ code: Review, security: Review, requirements: Review }),
  results: Schema.Struct(
    Object.fromEntries(V2_NATIVE_QUALIFICATION_SCOPES.map((name) => [name, Scope])) as Record<
      (typeof V2_NATIVE_QUALIFICATION_SCOPES)[number],
      typeof Scope
    >,
  ),
});

/** Immutable digest over every scope result in canonical scope order (assembly and validation). */
export function v2NativeQualificationResultsDigest(
  results: Readonly<Record<(typeof V2_NATIVE_QUALIFICATION_SCOPES)[number], unknown>>,
) {
  return createHash("sha256")
    .update(JSON.stringify(V2_NATIVE_QUALIFICATION_SCOPES.map((scope) => [scope, results[scope]])))
    .digest("hex");
}

/** Offline promotion preparation: all scopes and independent reviews must describe the same
 * frozen source/environment/image. It prints metadata only and cannot modify the runtime registry. */
export function prepareV2NativeQualificationRecord(value: unknown) {
  const packet = Schema.decodeUnknownSync(V2NativeQualificationEvidence)(value, {
      onExcessProperty: "error",
    }),
    record = packet.record;
  if (
    packet.binaryBefore !== record.testedBinarySha256 ||
    packet.binaryAfter !== record.testedBinarySha256 ||
    Object.values(packet.reviews).some(
      (review) => review.sourceSnapshotDigest !== record.sourceSnapshotDigest,
    ) ||
    new Set(Object.values(packet.reviews).map((review) => review.reviewer)).size !== 3
  )
    throw new Error("V2 native qualification image/source/review identity mismatch; no promotion.");
  for (const result of Object.values(packet.results))
    if (
      result.nativeVersion !== record.nativeVersion ||
      result.testedBinarySha256 !== record.testedBinarySha256 ||
      result.sourceSnapshotDigest !== record.sourceSnapshotDigest ||
      result.environmentEvidenceDigest !== record.environmentEvidenceDigest
    )
      throw new Error(
        "V2 native qualification scope belongs to another source/image/environment; no promotion.",
      );
  if (v2NativeQualificationResultsDigest(packet.results) !== record.resultsDigest)
    throw new Error("V2 native qualification immutable results digest mismatch.");
  return validateV2NativeQualificationRegistry([record], []).qualified.get(
    v2NativeEvidenceKey(record.nativeVersion, record.platform, record.arch),
  )!.record;
}
import { v2NativeEvidenceKey } from "./NativeCompatibility.platform.ts";
