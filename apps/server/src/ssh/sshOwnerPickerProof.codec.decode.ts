import { decodeMessage } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";

import {
  boolValue,
  bytesValue,
  EMPTY,
  invalid,
  PROOF_TOKEN_BYTES,
  stringValue,
  uintValue,
} from "./sshOwnerPickerProof.codec.wire.ts";
import { readReply, type Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";

export type Frame =
  | {
      kind: "helloAccepted";
      major: number;
      minor: number;
      ownerEpoch: Uint8Array;
      generation: Uint8Array;
      aliasDescriptor: Uint8Array;
      profileBinding: Uint8Array;
      /** W3.7: the owner has no pinned target and resolves one per request. */
      multiTarget: boolean;
      /** The owner acknowledged the restart reconciliation set. */
      reconciled: boolean;
      reconciliationId: Uint8Array;
      reconciliationDigest: Uint8Array;
      retirementCount: number;
      paneCount: number;
      reconciliationError: number;
    }
  | {
      kind: "reply";
      requestId: Uint8Array;
      ownerEpoch: Uint8Array;
      generation: Uint8Array;
      outcome: Outcome;
    }
  | { kind: "grantReply"; requestId: Uint8Array; grant: Uint8Array; error: number }
  | { kind: "storageHydrate"; targetId: string }
  | {
      kind: "reconcileHydrate";
      requestId: Uint8Array;
      ownerEpoch: Uint8Array;
      generation: Uint8Array;
    }
  | { kind: "attachChallenge"; serverNonce: Uint8Array; proof: Uint8Array }
  | {
      kind: "storageTransition";
      requestId: Uint8Array;
      targetId: string;
      writerEpoch: string;
      expectedSeq: number;
      disconnected: boolean;
    };

const readFrame = (field: number, bytes: Uint8Array): Frame => {
  switch (field) {
    case 2: {
      let major = 0,
        minor = 0,
        ownerEpoch = EMPTY,
        generation = EMPTY,
        aliasDescriptor = EMPTY,
        profileBinding = EMPTY,
        multiTarget = false,
        reconciled = false,
        reconciliationId = EMPTY,
        reconciliationDigest = EMPTY,
        retirementCount = 0,
        paneCount = 0,
        reconciliationError = 0;
      decodeMessage(bytes, (number, wire, reader) => {
        if (number === 1) major = uintValue(wire, reader);
        else if (number === 2) minor = uintValue(wire, reader);
        else if (number === 3) ownerEpoch = bytesValue(wire, reader);
        else if (number === 4) generation = bytesValue(wire, reader);
        else if (number === 5) aliasDescriptor = bytesValue(wire, reader);
        else if (number === 6) profileBinding = bytesValue(wire, reader);
        else if (number === 7) multiTarget = uintValue(wire, reader) === 1;
        else if (number === 8) reconciled = uintValue(wire, reader) === 1;
        else if (number === 9) reconciliationId = bytesValue(wire, reader);
        else if (number === 10) reconciliationDigest = bytesValue(wire, reader);
        else if (number === 11) retirementCount = uintValue(wire, reader);
        else if (number === 12) paneCount = uintValue(wire, reader);
        else if (number === 13) reconciliationError = uintValue(wire, reader);
        else reader.skip(wire);
      });
      return {
        kind: "helloAccepted",
        major,
        minor,
        ownerEpoch,
        generation,
        aliasDescriptor,
        profileBinding,
        multiTarget,
        reconciled,
        reconciliationId,
        reconciliationDigest,
        retirementCount,
        paneCount,
        reconciliationError,
      };
    }
    case 4:
      return readReply(bytes);
    case 6: {
      let requestId = EMPTY,
        grant = EMPTY,
        error = 0;
      decodeMessage(bytes, (number, wire, reader) => {
        if (number === 1) requestId = bytesValue(wire, reader);
        else if (number === 2) grant = bytesValue(wire, reader);
        else if (number === 3) error = uintValue(wire, reader);
        else reader.skip(wire);
      });
      if ((error === 0) === (grant.length === 0)) return invalid();
      return { kind: "grantReply", requestId, grant, error };
    }
    case 7: {
      let targetId = "";
      decodeMessage(bytes, (number, wire, reader) => {
        if (number === 1) targetId = stringValue(wire, reader);
        else reader.skip(wire);
      });
      return { kind: "storageHydrate", targetId };
    }
    case 18: {
      let requestId = EMPTY,
        ownerEpoch = EMPTY,
        generation = EMPTY;
      decodeMessage(bytes, (number, wire, reader) => {
        if (number === 1) requestId = bytesValue(wire, reader);
        else if (number === 2) ownerEpoch = bytesValue(wire, reader);
        else if (number === 3) generation = bytesValue(wire, reader);
        else reader.skip(wire);
      });
      if (requestId.length !== PROOF_TOKEN_BYTES) return invalid();
      return { kind: "reconcileHydrate", requestId, ownerEpoch, generation };
    }
    case 9: {
      let requestId = EMPTY,
        targetId = "",
        writerEpoch = "",
        expectedSeq = 0,
        disconnected = false;
      decodeMessage(bytes, (number, wire, reader) => {
        if (number === 1) requestId = bytesValue(wire, reader);
        else if (number === 2) targetId = stringValue(wire, reader);
        else if (number === 3) writerEpoch = stringValue(wire, reader);
        else if (number === 4) expectedSeq = uintValue(wire, reader);
        else if (number === 5) disconnected = boolValue(wire, reader);
        else reader.skip(wire);
      });
      return {
        kind: "storageTransition",
        requestId,
        targetId,
        writerEpoch,
        expectedSeq,
        disconnected,
      };
    }
    case 12: {
      let serverNonce: Uint8Array | undefined;
      let proof: Uint8Array | undefined;
      decodeMessage(bytes, (number, wire, reader) => {
        if (number === 1 && serverNonce === undefined) serverNonce = bytesValue(wire, reader);
        else if (number === 2 && proof === undefined) proof = bytesValue(wire, reader);
        else return invalid();
      });
      if (serverNonce?.length !== PROOF_TOKEN_BYTES || proof?.length !== PROOF_TOKEN_BYTES)
        return invalid();
      return { kind: "attachChallenge", serverNonce, proof };
    }
    default:
      return invalid();
  }
};

export const decodeOwnerFrame = (bytes: Uint8Array): Frame => {
  let frame: Frame | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (frame !== undefined) return invalid();
    frame = readFrame(field, bytesValue(wire, reader));
  });
  return frame ?? invalid();
};
