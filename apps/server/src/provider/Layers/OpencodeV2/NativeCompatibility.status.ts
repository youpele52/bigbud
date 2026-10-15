import type { V2NativeRuntimeProof } from "./NativeCompatibility.types.ts";

/** Runtime checking and synthetic candidate evidence never claim a completed retail record. */
export function v2NativeProofMetadata(proof: V2NativeRuntimeProof) {
  return {
    nativeVersion: proof.nativeVersion,
    nativeContractDigest: proof.nativeContractDigest,
    qualificationState:
      proof.evidenceKind === "qualified"
        ? ("qualified" as const)
        : proof.evidenceKind === "runtime-checked"
          ? ("unqualified" as const)
          : ("required" as const),
    ...(proof.evidenceKind === "qualified" && proof.qualificationRecordId
      ? { qualificationRecordId: proof.qualificationRecordId }
      : {}),
    semanticProfile: proof.semanticProfile,
  };
}

/** Successful runtime readiness is usable with an amber disclosure, not a false qualification claim. */
export function v2NativeReadyNotice(
  qualificationState: string | undefined,
  qualifiedMessage: string,
) {
  return qualificationState === "unqualified"
    ? {
        severity: "warning" as const,
        message:
          "Connected; runtime bridge checks passed. Native semantic qualification is incomplete.",
      }
    : { severity: "success" as const, message: qualifiedMessage };
}
