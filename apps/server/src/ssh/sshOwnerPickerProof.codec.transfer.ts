/**
 * C15 / W2 T-xfer: reserved transfer handoff boundary.
 *
 * `transferStream` (wire `proof_transfer_stream`, field 74) and
 * `packagedRsync` (wire `proof_packaged_rsync`, field 75) are declared for the
 * post-S4 transfer handoff. They are **not enabled for real transfers in
 * S1-S4**: no product request policy admits them, the shared product encoder
 * refuses them, and the product decoder refuses their outcomes. The only
 * consumer is the disposable native fixture in the Rust owner crate.
 *
 * Nothing here can emit or decode a transfer frame. There is deliberately no
 * writer function: a future promotion replaces this module, it does not widen
 * it, and it cannot be reached by casting an operation kind.
 *
 * @module sshOwnerPickerProof.codec.transfer
 */
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

export const RESERVED_TRANSFER_VERBS = [
  { wire: "proof_transfer_stream", production: "transferStream", field: 74 },
  { wire: "proof_packaged_rsync", production: "packagedRsync", field: 75 },
] as const;

export const RESERVED_TRANSFER_OUTCOMES = [
  { wire: "proof_transfer_stream_state", field: 47 },
  { wire: "proof_transfer_child_state", field: 48 },
] as const;

/** The single refusal used by the product encoder for a reserved transfer verb. */
export function refuseReservedTransferOperation(operation: { readonly kind: string }): void {
  if (RESERVED_TRANSFER_VERBS.some((verb) => verb.wire === operation.kind)) {
    throw new PickerProofOwnerError("operationDenied");
  }
}

export function isReservedTransferOutcome(field: number): boolean {
  return RESERVED_TRANSFER_OUTCOMES.some((outcome) => outcome.field === field);
}
