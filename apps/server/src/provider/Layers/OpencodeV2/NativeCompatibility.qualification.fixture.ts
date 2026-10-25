import { OPENCODE_V2_CLIENT_VERSION } from "./Compatibility.ts";
import { V2_NATIVE_CONTRACT_DIGEST } from "./NativeCompatibility.contract.ts";
import { V2_NATIVE_QUALIFICATION_SCOPES } from "./NativeCompatibility.types.ts";
import { V2_COMPATIBILITY_DIGEST } from "./Orchestration.compatibility.ts";

/** Synthetic metadata for validator mechanics only; never inserted into the production registry. */
export function syntheticV2QualificationRecord(nativeVersion = "2.0.28") {
  return {
    format: "bigbud.thread.native-qualification.v1",
    nativeVersion,
    platform: "darwin",
    arch: "arm64",
    clientVersion: OPENCODE_V2_CLIENT_VERSION,
    nativeContractDigest: V2_NATIVE_CONTRACT_DIGEST,
    bootstrapContractDigests: [V2_COMPATIBILITY_DIGEST],
    bootstrapGeneratorSourceDigest: "a".repeat(64),
    semanticProfile: "v2-system-global-config-v1",
    suiteRevision: "synthetic-not-native-qualification",
    sourceSnapshotDigest: "b".repeat(64),
    testedBinarySha256: "c".repeat(64),
    nativeSourceCommit: "d".repeat(40),
    environmentEvidenceDigest: "e".repeat(64),
    resultsDigest: "f".repeat(64),
    completedAt: "2026-01-01T00:00:00.000Z",
    scopes: Object.fromEntries(V2_NATIVE_QUALIFICATION_SCOPES.map((name) => [name, "passed"])),
  };
}
