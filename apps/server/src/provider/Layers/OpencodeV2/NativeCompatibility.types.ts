import * as Schema from "effect/Schema";
import { OPENCODE_V2_CLIENT_VERSION } from "./Compatibility.ts";
export const V2NativePlatform = Schema.Literals(["darwin", "linux", "win32"]);
export const V2NativeArch = Schema.Literals(["arm64", "x64"]);

export const V2_NATIVE_QUALIFICATION_SCOPES = [
  "api-transport-admission",
  "native-tool-schema-catalog-permissions",
  "isolation-hooks",
  "rpc-crypto-cancellation",
  "history-receipt-approval-integration",
  "source-config-autoload",
  "two-location-lifecycle",
  "packaged-ab",
] as const;
export const V2NativeSemanticProfile = Schema.Literals([
  "v2-global-config-v1",
  "v2-system-global-config-v1",
]);
export type V2NativeSemanticProfile = typeof V2NativeSemanticProfile.Type;
const Hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
export const V2NativeQualificationRecord = Schema.Struct({
  nativeFamilySourceDigest: Schema.optionalKey(Hex),
  format: Schema.Literal("bigbud.thread.native-qualification.v1"),
  nativeVersion: Text,
  platform: V2NativePlatform,
  arch: V2NativeArch,
  clientVersion: Schema.Literal(OPENCODE_V2_CLIENT_VERSION),
  nativeContractDigest: Hex,
  bootstrapContractDigests: Schema.Array(Hex).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  bootstrapGeneratorSourceDigest: Hex,
  semanticProfile: V2NativeSemanticProfile,
  suiteRevision: Text,
  sourceSnapshotDigest: Hex,
  testedBinarySha256: Hex,
  nativeSourceCommit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  environmentEvidenceDigest: Hex,
  resultsDigest: Hex,
  completedAt: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  ),
  scopes: Schema.Struct(
    Object.fromEntries(
      V2_NATIVE_QUALIFICATION_SCOPES.map((name) => [name, Schema.Literal("passed")]),
    ) as Record<(typeof V2_NATIVE_QUALIFICATION_SCOPES)[number], Schema.Literal<"passed">>,
  ),
});
export type V2NativeQualificationRecord = typeof V2NativeQualificationRecord.Type;
export const V2NativeIncompatibleRecord = Schema.Struct({
  format: Schema.Literal("bigbud.thread.native-incompatible.v1"),
  nativeVersion: Text,
  platform: V2NativePlatform,
  arch: V2NativeArch,
  nativeContractDigest: Hex,
  scope: Schema.Literals(V2_NATIVE_QUALIFICATION_SCOPES),
  reason: Text,
  resultsDigest: Hex,
});
export type V2NativeIncompatibleRecord = typeof V2NativeIncompatibleRecord.Type;

export type V2NativeCompatibilityReason =
  | "native-version-unsupported"
  | "native-contract-incompatible"
  | "native-qualification-required"
  | "native-qualification-incompatible"
  | "config-source-unverified"
  | "bootstrap-contract-incompatible"
  | "native-generation-changed";

/** Safe classified diagnostics only; never retain native spec, credentials or policy documents. */
export class V2NativeCompatibilityError extends Error {
  readonly nativeVersion?: string;
  constructor(
    readonly reasonCode: V2NativeCompatibilityReason,
    message: string,
    nativeVersion?: string,
  ) {
    super(`V2 ${message}`);
    if (
      nativeVersion &&
      nativeVersion.length <= 50 &&
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(nativeVersion)
    )
      this.nativeVersion = nativeVersion;
  }
}

export interface V2NativeRuntimeProof {
  /** Release-reviewed custom runtime source identity; absent for stock native builds. */
  readonly nativeFamilySourceDigest?: string;
  readonly evidenceKind: "qualified" | "candidate" | "runtime-checked";
  readonly assertCurrent: () => void;
  readonly assertConfigRead: () => void;
  readonly transport: string;
  readonly generation: string;
  readonly nativeVersion: string;
  readonly platform: typeof V2NativePlatform.Type;
  readonly arch: typeof V2NativeArch.Type;
  readonly nativeContractDigest: string;
  readonly semanticProfile: V2NativeSemanticProfile;
  readonly qualificationRecordId?: string;
  readonly consumedApiDigest: string;
  readonly directory: string;
  readonly root: string;
  readonly consentRevision: number;
  readonly compatibilityDigest: string;
}
