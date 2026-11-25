import {
  OWNER_MINOR,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
} from "./sshOwnerPickerProof.codec.ts";
import { invalid as invalidProtocol } from "./sshOwnerPickerProof.codec.wire.ts";

interface HelloAcceptedFrame {
  readonly kind: string;
  readonly major?: number;
  readonly minor?: number;
  readonly ownerEpoch?: Uint8Array;
  readonly generation?: Uint8Array;
  readonly aliasDescriptor?: Uint8Array;
  readonly profileBinding?: Uint8Array;
  readonly multiTarget?: boolean;
}

/** Validate the owner's HelloAccepted before admitting any request on the session. */
export function acceptPickerProofHello(
  accepted: HelloAcceptedFrame,
  major: number,
  expectedProfileBinding: Uint8Array,
) {
  if (accepted.kind !== "helloAccepted") return invalidProtocol();
  if (accepted.major !== major || accepted.minor !== OWNER_MINOR) {
    throw new PickerProofOwnerError("versionIncompatible");
  }
  const {
    ownerEpoch,
    generation,
    aliasDescriptor = new Uint8Array(),
    profileBinding = new Uint8Array(),
    multiTarget = false,
  } = accepted;
  if (
    ownerEpoch?.length !== PROOF_TOKEN_BYTES ||
    // A multi-target owner has no pinned target, so it reports no generation.
    generation?.length !== (multiTarget ? 0 : PROOF_TOKEN_BYTES) ||
    (aliasDescriptor.length !== 0 && aliasDescriptor.length !== 32) ||
    (multiTarget && aliasDescriptor.length !== 0)
  ) {
    return invalidProtocol();
  }
  // The owner must echo the exact startup binding. A descriptor or session that
  // names another profile is never adopted.
  if (!Buffer.from(profileBinding).equals(Buffer.from(expectedProfileBinding))) {
    throw new PickerProofOwnerError("profileMismatch");
  }
  // An owner without an alias policy reports no descriptor; never synthesize one.
  return {
    ownerEpoch,
    generation,
    multiTarget,
    aliasDescriptor: aliasDescriptor.length ? Uint8Array.from(aliasDescriptor) : undefined,
  };
}
