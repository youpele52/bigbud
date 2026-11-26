import { isLocalProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import type { PiRpcProcessOptions } from "./RpcProcess.types.ts";

const capabilityLabels = {
  "remote-rpc-start": "remote RPC start",
  "remote-version-probe": "remote version probing",
} as const;

class SelectedSshOwnerPiCapabilityError extends Error {
  readonly code = "unsupported-by-selected-ssh-owner";

  constructor(readonly capability: keyof typeof capabilityLabels) {
    super(`Pi ${capabilityLabels[capability]} is unavailable with the production SSH owner.`);
    this.name = "SelectedSshOwnerPiCapabilityError";
  }
}

/**
 * `ownerAvailable` means the live production owner already resolved a typed Pi port bound to
 * this runtime. Without it the start refuses; there is no TypeScript SSH launch. A local
 * runtime with a remote workspace is admitted: its bridge tools run through the server's
 * typed tool transport (the owner's workspace verbs for a direct SSH workspace).
 */
export function getPiRpcCapabilityDenial(
  targets: Pick<PiRpcProcessOptions, "providerRuntimeTarget" | "workspaceTarget">,
  operation: "rpc-start" | "version-probe",
  ownerAvailable = false,
): SelectedSshOwnerPiCapabilityError | undefined {
  if (!isLocalProviderRuntimeTarget(targets.providerRuntimeTarget)) {
    // The native Pi proof's pinned, one-shot fixture grant is not a product provider grant.
    // A selected graph must not substitute legacy SSH, even for a different remote target.
    return ownerAvailable
      ? undefined
      : new SelectedSshOwnerPiCapabilityError(
          operation === "rpc-start" ? "remote-rpc-start" : "remote-version-probe",
        );
  }
  return undefined;
}
