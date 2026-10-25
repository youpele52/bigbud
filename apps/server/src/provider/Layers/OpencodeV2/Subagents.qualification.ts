import { Schema } from "effect";
import type { V2NativeRuntimeProof } from "./NativeCompatibility.types.ts";

export const NativeFamilyQualification = Schema.Struct({
  id: Schema.String,
  nativeQualificationRecordId: Schema.String,
  nativeVersion: Schema.String,
  guardDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  immutableSourceDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  executorProgressBeforePrompt: Schema.Literal(true),
  finalPermissionClamp: Schema.Literal(true),
  authenticatedRootGeneration: Schema.Literal(true),
  nativePromptHookFencesAdmission: Schema.Literal(true),
  // Stock native lacks admission provenance. The custom ABI also requires exact
  // reviewed source/artifact evidence; a capability string alone never enables it.
  syntheticAdmission: Schema.Literals(["unsupported", "opencode.native-family.v1"]),
  nativeFamilySourceDigest: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  ),
});
export type NativeFamilyQualification = typeof NativeFamilyQualification.Type;
/** Release-owned evidence only. Offline transport fixtures never add executable/runner approval. */
export const V2_NATIVE_FAMILY_QUALIFICATIONS: readonly NativeFamilyQualification[] = Object.freeze(
  [],
);

export function selectV2NativeFamilyQualification(
  proof: V2NativeRuntimeProof,
  guardDigest: string,
  records = V2_NATIVE_FAMILY_QUALIFICATIONS,
) {
  proof.assertCurrent();
  if (proof.evidenceKind !== "qualified" || !proof.qualificationRecordId) return;
  const matching = records.filter(
    (entry) =>
      entry.nativeQualificationRecordId === proof.qualificationRecordId &&
      entry.nativeVersion === proof.nativeVersion &&
      entry.guardDigest === guardDigest,
  );
  if (matching.length !== 1) return;
  return Schema.decodeUnknownSync(NativeFamilyQualification)(matching[0], {
    onExcessProperty: "error",
  });
}
