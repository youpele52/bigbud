/**
 * Peer enrollment client over the admitted owner session (T-peer / U9). The
 * client validates operands locally and accepts only the matching public
 * metadata reply; it never reads or writes a key file.
 *
 * @module sshOwnerPickerProof.client.peerEnrollment
 */
import {
  isPeerEnrollmentTarget,
  type PeerCoordinatorKeyMetadata,
  type PeerHostKeyMetadata,
  type ProofPeerEnrollmentOperation,
} from "./sshOwnerPickerProof.codec.peerEnrollment.ts";
import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import { invalid, PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

export type ExecuteProofPeerEnrollment = (
  operation: ProofPeerEnrollmentOperation,
) => Promise<Outcome>;

export interface PickerProofPeerEnrollmentClient {
  /** Provision or reuse the profile-bound coordinator key. Public metadata only. */
  ensurePeerCoordinatorKey(): Promise<PeerCoordinatorKeyMetadata>;
  /** One-shot inspection of the exact host and port; no pin is saved. */
  inspectPeerHostKey(host: string, port: number): Promise<PeerHostKeyMetadata>;
}

export function makePickerProofPeerEnrollmentClient(
  execute: ExecuteProofPeerEnrollment,
): PickerProofPeerEnrollmentClient {
  return {
    async ensurePeerCoordinatorKey() {
      const outcome = await execute({ kind: "proofEnsurePeerCoordinatorKey" });
      if (outcome.kind !== "proofPeerCoordinatorKey") return invalid();
      return outcome.value;
    },
    async inspectPeerHostKey(host, port) {
      if (!isPeerEnrollmentTarget(host, port)) throw new PickerProofOwnerError("invalidOperands");
      const outcome = await execute({ kind: "proofInspectPeerHostKey", host, port });
      if (outcome.kind !== "proofPeerHostKey") return invalid();
      return outcome.value;
    },
  };
}
