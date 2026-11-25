import { isLocalProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import { isSshOwnerDevFixtureSelected } from "../../../ssh/sshOwnerSelection.ts";
import { isRemoteWorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import type { PiRpcProcessOptions } from "./RpcProcess.types.ts";

const capabilityLabels = {
  "remote-rpc-start": "remote RPC start",
  "remote-version-probe": "remote version probing",
  "remote-workspace-bridge": "local-runtime remote workspace bridge",
} as const;

class SelectedSshOwnerPiCapabilityError extends Error {
  readonly code = "unsupported-by-selected-ssh-owner";

  constructor(readonly capability: keyof typeof capabilityLabels) {
    super(`Pi ${capabilityLabels[capability]} is unavailable with the source-dev SSH owner.`);
    this.name = "SelectedSshOwnerPiCapabilityError";
  }
}

/**
 * `ownerAvailable` means the selected dev owner already resolved a typed Pi port bound to this
 * runtime. Without it, a selected graph refuses rather than starting legacy SSH.
 */
export function getPiRpcCapabilityDenial(
  targets: Pick<PiRpcProcessOptions, "providerRuntimeTarget" | "workspaceTarget">,
  operation: "rpc-start" | "version-probe",
  ownerAvailable = false,
): SelectedSshOwnerPiCapabilityError | undefined {
  if (!isSshOwnerDevFixtureSelected()) return undefined;

  if (!isLocalProviderRuntimeTarget(targets.providerRuntimeTarget)) {
    // The native Pi proof's pinned, one-shot fixture grant is not a product provider grant.
    // A selected graph must not substitute legacy SSH, even for a different remote target.
    return ownerAvailable
      ? undefined
      : new SelectedSshOwnerPiCapabilityError(
          operation === "rpc-start" ? "remote-rpc-start" : "remote-version-probe",
        );
  }
  if (operation === "rpc-start" && isRemoteWorkspaceTarget(targets.workspaceTarget)) {
    return new SelectedSshOwnerPiCapabilityError("remote-workspace-bridge");
  }
  return undefined;
}
