import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import type {
  GitReceiveApproval,
  GitReceiveState,
} from "./sshOwnerPickerProof.codec.gitReceive.ts";
import {
  invalid,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
} from "./sshOwnerPickerProof.codec.wire.ts";

/**
 * U15 production Git receive (push) lease on one bound target. The approval fixes the one
 * update the owner may forward; the owner selects the command and creates the socket.
 *
 * @module sshOwnerPickerProof.client.productionGitReceive
 */
export interface PickerProofProductionGitReceiveClient {
  openGitReceive(lease: Uint8Array, approval: GitReceiveApproval): Promise<GitReceiveState>;
  gitReceiveStatus(lease: Uint8Array): Promise<GitReceiveState>;
  closeGitReceive(lease: Uint8Array): Promise<GitReceiveState>;
}

type Execute = (operation: PickerProofOperation) => Promise<Outcome>;

function copyLease(lease: Uint8Array): Uint8Array {
  if (lease.length !== PROOF_TOKEN_BYTES) throw new PickerProofOwnerError("invalidOperands");
  return Uint8Array.from(lease);
}

/** Receive leases poll their status while other targets use the owner, so they queue. */
export function makePickerProofProductionGitReceiveClient(
  queued: Execute,
): PickerProofProductionGitReceiveClient {
  const receive = async (operation: PickerProofOperation) => {
    const outcome = await queued(operation);
    return outcome.kind === "gitReceive" ? outcome.value : invalid();
  };
  return {
    openGitReceive: (lease, approval) =>
      receive({
        kind: "gitReceiveOpen",
        lease: copyLease(lease),
        workspaceRoot: approval.workspaceRoot,
        repositoryPath: approval.repositoryPath,
        destinationRef: approval.destinationRef,
        expectedOldOid: approval.expectedOldOid,
        sourceOid: approval.sourceOid,
      }),
    gitReceiveStatus: (lease) => receive({ kind: "gitReceiveStatus", lease: copyLease(lease) }),
    closeGitReceive: (lease) => receive({ kind: "gitReceiveClose", lease: copyLease(lease) }),
  };
}
