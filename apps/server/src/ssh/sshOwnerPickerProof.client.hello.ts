import {
  OWNER_MINOR,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
  decodeOwnerError,
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
  readonly reconciled?: boolean;
  readonly reconciliationId?: Uint8Array;
  readonly reconciliationDigest?: Uint8Array;
  readonly retirementCount?: number;
  readonly paneCount?: number;
  readonly reconciliationError?: number;
}

export interface ExpectedReconciliation {
  readonly requestId: Uint8Array;
  readonly digest: Uint8Array;
}

/** Maps the owner's typed reconciliation refusal onto the shared client error. */
function refusedReconciliation(code: number): never {
  if (code === 13) throw new PickerProofOwnerError("storageUnavailable");
  const decoded = decodeOwnerError(code);
  if (decoded === "ownerRetirementUnverified" || decoded === "paneUnrecoverable")
    throw new PickerProofOwnerError(decoded);
  return invalidProtocol();
}

/**
 * Validate the owner's HelloAccepted before admitting any request on the
 * session. A multi-target owner must also acknowledge the exact reconciliation
 * round this client answered; an earlier round's acknowledgement is refused.
 */
export function acceptPickerProofHello(
  accepted: HelloAcceptedFrame,
  major: number,
  expectedProfileBinding: Uint8Array,
  reconciliation?: ExpectedReconciliation,
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
    reconciled = false,
    reconciliationId = new Uint8Array(),
    reconciliationDigest = new Uint8Array(),
    retirementCount = 0,
    paneCount = 0,
    reconciliationError = 0,
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
  if (reconciliationError !== 0) refusedReconciliation(reconciliationError);
  if (reconciliation !== undefined) {
    // A partial set, a stale round or a silently skipped hydration never admits.
    if (
      !reconciled ||
      !Buffer.from(reconciliationId).equals(Buffer.from(reconciliation.requestId)) ||
      !Buffer.from(reconciliationDigest).equals(Buffer.from(reconciliation.digest))
    ) {
      return invalidProtocol();
    }
  } else if (multiTarget) {
    // Production owners admit only after acknowledging both hydrated sets.
    return invalidProtocol();
  }
  // An owner without an alias policy reports no descriptor; never synthesize one.
  return {
    ownerEpoch,
    generation,
    multiTarget,
    aliasDescriptor: aliasDescriptor.length ? Uint8Array.from(aliasDescriptor) : undefined,
    reconciliation:
      reconciliation === undefined
        ? undefined
        : {
            acknowledged: reconciled,
            retirements: retirementCount,
            panes: paneCount,
          },
  };
}
