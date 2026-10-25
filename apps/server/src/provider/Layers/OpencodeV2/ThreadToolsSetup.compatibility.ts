import { V2NativeCompatibilityError } from "./NativeCompatibility.types.ts";
import { V2_NATIVE_CONTRACT_DIGEST } from "./NativeCompatibility.contract.ts";

/** Classification preserves model discovery and exposes no native config/spec/credential contents. */
export function v2NativeCompatibilitySetupResult(error: unknown) {
  if (!(error instanceof V2NativeCompatibilityError)) return {};
  const required = error.reasonCode === "native-qualification-required";
  return {
    status: "required" as const,
    activationState: "blocked" as const,
    artifactDigest: "",
    reasonCode: error.reasonCode,
    ...(error.nativeVersion ? { nativeVersion: error.nativeVersion } : {}),
    nativeContractDigest: V2_NATIVE_CONTRACT_DIGEST,
    qualificationState: required ? ("required" as const) : ("incompatible" as const),
    severity: required ? ("warning" as const) : ("error" as const),
    message: error.message,
  };
}
