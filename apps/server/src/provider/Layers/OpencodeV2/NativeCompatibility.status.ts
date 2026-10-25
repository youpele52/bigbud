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

/** Passed runtime bridge checks are ready; release qualification evidence is not a user action. */
export function v2NativeReadyNotice(message: string) {
  return { severity: "success" as const, message };
}
