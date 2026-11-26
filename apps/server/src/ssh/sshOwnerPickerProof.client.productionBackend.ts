import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import type {
  ClientRelayLeaseState,
  DeploymentStepOperands,
  DeploymentStepState,
} from "./sshOwnerPickerProof.codec.backend.ts";
import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import {
  invalid,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
} from "./sshOwnerPickerProof.codec.wire.ts";

/** The persisted profile's pinned relay installation; never a renderer value. */
export interface ClientRelayLeaseBinding {
  readonly nodeBinary: string;
  readonly nodeSha256: string;
  readonly helperEntry: string;
  readonly helperSha256: string;
  readonly authorityId: string;
}

/**
 * W2 T-backend production leases on one bound target. The caller-chosen lease token
 * is the operation identity: opening the same token again, or reading its status,
 * returns the retained outcome and never dispatches the step a second time.
 */
export interface PickerProofProductionBackendClient {
  openDeploymentStep(lease: Uint8Array, step: DeploymentStepOperands): Promise<DeploymentStepState>;
  deploymentStepStatus(lease: Uint8Array): Promise<DeploymentStepState>;
  /** Cancel this step lease only; the owner kills its child and confirms the reap. */
  cancelDeploymentStep(lease: Uint8Array): Promise<DeploymentStepState>;
  openClientRelayLease(
    lease: Uint8Array,
    binding: ClientRelayLeaseBinding,
  ): Promise<ClientRelayLeaseState>;
  clientRelayLeaseStatus(lease: Uint8Array): Promise<ClientRelayLeaseState>;
  closeClientRelayLease(lease: Uint8Array): Promise<ClientRelayLeaseState>;
}

type Execute = (operation: PickerProofOperation) => Promise<Outcome>;

const copyLease = (lease: Uint8Array) => {
  if (lease.length !== PROOF_TOKEN_BYTES) throw new PickerProofOwnerError("invalidOperands");
  return Uint8Array.from(lease);
};

export function makePickerProofProductionBackendClient(
  execute: Execute,
): PickerProofProductionBackendClient {
  const step = async (operation: PickerProofOperation) => {
    const outcome = await execute(operation);
    return outcome.kind === "deploymentStep" ? outcome.value : invalid();
  };
  const relay = async (operation: PickerProofOperation) => {
    const outcome = await execute(operation);
    return outcome.kind === "clientRelayLease" ? outcome.value : invalid();
  };
  return {
    openDeploymentStep: (lease, operands) =>
      step({ kind: "deploymentStepOpen", lease: copyLease(lease), step: operands }),
    deploymentStepStatus: (lease) =>
      step({ kind: "deploymentStepStatus", lease: copyLease(lease) }),
    cancelDeploymentStep: (lease) =>
      step({ kind: "deploymentStepCancel", lease: copyLease(lease) }),
    openClientRelayLease: (lease, binding) =>
      relay({ kind: "clientRelayLeaseOpen", lease: copyLease(lease), ...binding }),
    clientRelayLeaseStatus: (lease) =>
      relay({ kind: "clientRelayLeaseStatus", lease: copyLease(lease) }),
    closeClientRelayLease: (lease) =>
      relay({ kind: "clientRelayLeaseClose", lease: copyLease(lease) }),
  };
}
