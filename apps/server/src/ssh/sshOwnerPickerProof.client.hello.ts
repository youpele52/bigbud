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
}

/** Validate the owner's HelloAccepted before admitting any request on the session. */
export function acceptPickerProofHello(accepted: HelloAcceptedFrame, major: number) {
  if (accepted.kind !== "helloAccepted") return invalidProtocol();
  if (accepted.major !== major || accepted.minor !== OWNER_MINOR) {
    throw new PickerProofOwnerError("versionIncompatible");
  }
  const { ownerEpoch, generation, aliasDescriptor = new Uint8Array() } = accepted;
  if (
    ownerEpoch?.length !== PROOF_TOKEN_BYTES ||
    generation?.length !== PROOF_TOKEN_BYTES ||
    (aliasDescriptor.length !== 0 && aliasDescriptor.length !== 32)
  ) {
    return invalidProtocol();
  }
  // An owner without an alias policy reports no descriptor; never synthesize one.
  return {
    ownerEpoch,
    generation,
    aliasDescriptor: aliasDescriptor.length ? Uint8Array.from(aliasDescriptor) : undefined,
  };
}
