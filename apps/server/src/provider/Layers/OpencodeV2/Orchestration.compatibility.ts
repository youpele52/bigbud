import { createHash } from "node:crypto";
import { V2_BOOTSTRAP_ABI } from "./Orchestration.plugin.specs.ts";
import { V2_IMPLEMENTATION_MANIFEST } from "./Orchestration.implementation.manifest.generated.ts";
import { V2_ENROLLMENT_PROTOCOL } from "./Orchestration.protocol.ts";
import { V2_NATIVE_CONTRACT_DIGEST } from "./NativeCompatibility.contract.ts";
import {
  V2_N0_BOOTSTRAP_COMPATIBILITY,
  V2_N0_COMPATIBILITY_DIGEST,
  V2_N1_BOOTSTRAP_COMPATIBILITY,
  V2_N1_COMPATIBILITY_DIGEST,
  V2_N2_BOOTSTRAP_COMPATIBILITY,
  V2_N2_COMPATIBILITY_DIGEST,
  V2_N3_BOOTSTRAP_COMPATIBILITY,
  V2_N3_COMPATIBILITY_DIGEST,
} from "./Orchestration.compatibility.legacy.ts";
import { V2_SCOPED_BOOTSTRAP_ABI, V2_SCOPED_REGISTRATION } from "./Orchestration.registration.ts";
import type { V2ThreadImplementation } from "./Orchestration.implementation.types.ts";

/** Native compatibility excludes app default/version/code; actual module bytes have a separate noncircular digest. */
export const V2_BOOTSTRAP_COMPATIBILITY = Object.freeze({
  format: "bigbud.thread.compatibility.v2",
  bootstrapAbi: V2_SCOPED_BOOTSTRAP_ABI,
  registration: V2_SCOPED_REGISTRATION,
  enrollmentProtocol: V2_ENROLLMENT_PROTOCOL,
  callbackProtocol: "bigbud.thread.callback.v1",
  schemaDigest: V2_IMPLEMENTATION_MANIFEST.v1.schemaDigest,
  canonicalRequestAbi: "bigbud.thread.canonical.v1",
  resultEncoding: "bigbud.thread.final-json.v1",
  nativeContractDigest: V2_NATIVE_CONTRACT_DIGEST,
});
export const V2_COMPATIBILITY_DIGEST = createHash("sha256")
  .update(JSON.stringify(V2_BOOTSTRAP_COMPATIBILITY))
  .digest("hex");

export type V2BootstrapCompatibility =
  | typeof V2_BOOTSTRAP_COMPATIBILITY
  | typeof V2_N1_BOOTSTRAP_COMPATIBILITY
  | typeof V2_N2_BOOTSTRAP_COMPATIBILITY
  | typeof V2_N3_BOOTSTRAP_COMPATIBILITY
  | typeof V2_N0_BOOTSTRAP_COMPATIBILITY;

/** Resolve the installed descriptor's own exact bytes; never normalize old signatures to the preferred one. */
export function knownV2BootstrapCompatibility(
  value: unknown,
  digest: unknown,
): V2BootstrapCompatibility {
  for (const [descriptor, expected] of [
    [V2_BOOTSTRAP_COMPATIBILITY, V2_COMPATIBILITY_DIGEST],
    [V2_N0_BOOTSTRAP_COMPATIBILITY, V2_N0_COMPATIBILITY_DIGEST],
    [V2_N1_BOOTSTRAP_COMPATIBILITY, V2_N1_COMPATIBILITY_DIGEST],
    [V2_N2_BOOTSTRAP_COMPATIBILITY, V2_N2_COMPATIBILITY_DIGEST],
    [V2_N3_BOOTSTRAP_COMPATIBILITY, V2_N3_COMPATIBILITY_DIGEST],
  ] as const)
    if (digest === expected && JSON.stringify(value) === JSON.stringify(descriptor))
      return descriptor;
  throw new Error(
    "V2 unknown retained bootstrap compatibility descriptor; original evidence retained.",
  );
}

export function assertV2ImplementationCompatible(
  implementation: V2ThreadImplementation,
  descriptor: V2BootstrapCompatibility = V2_BOOTSTRAP_COMPATIBILITY,
) {
  for (const field of [
    "bootstrapAbi",
    "schemaDigest",
    "canonicalRequestAbi",
    "resultEncoding",
  ] as const)
    if (
      implementation[field] !== descriptor[field] &&
      !(
        field === "bootstrapAbi" &&
        implementation.bootstrapAbi === V2_BOOTSTRAP_ABI &&
        (descriptor === V2_BOOTSTRAP_COMPATIBILITY || descriptor === V2_N3_BOOTSTRAP_COMPATIBILITY)
      )
    )
      throw new Error(
        "V2 selected implementation is incompatible with the stable bootstrap contract.",
      );
}
