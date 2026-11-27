import {
  requireWireType,
  WireWriter,
  type WireReader,
} from "../remote-agent/remoteAgentProtocol.codec.wire.ts";

export const message = (field: number, write: (writer: WireWriter) => void) => {
  const body = new WireWriter();
  write(body);
  const frame = new WireWriter();
  frame.fieldRepeatedMessage(field, body.finish());
  return frame.finish();
};

export const PROOF_TOKEN_BYTES = 32;
export const EMPTY: Uint8Array = new Uint8Array();
const wireErrorCodes = [
  undefined,
  "ownerUnavailable",
  "operationDenied",
  "invalidOperands",
  "targetDisconnected",
  "configUnsupported",
  "trustRequired",
  "hostKeyChanged",
  "trustStoreReadOnly",
  "authRequired",
  "transportLost",
  "listFailed",
  "staleGeneration",
  "storageUnavailable",
  "outcomeUnknown",
  "listTimedOut",
  "listPathUnavailable",
  "listInvalidOutput",
  "workspacePathDenied",
  "workspaceReadFailed",
  "workspaceFileTooLarge",
  "workspaceWriteFailed",
  "proofRipgrepUnavailable",
  "proofDeploymentTimeout",
  "proofDeploymentOutputLimit",
  "listCancelled",
  "healthCancelled",
  "routeUnavailable",
  "sessionQuota",
  "windowsPasswordUnsupported",
  "keyboardInteractiveUnsupported",
  "ownerRetirementUnverified",
  "shellTimedOut",
  "shellCancelled",
  "targetUnknown",
  "targetMismatch",
  "paneUnrecoverable",
  "targetHostUnresolved",
  "providerExecutableUnavailable",
] as const;
/** Lane-allocated codes past the dense table (W2 T-term owns 55–58, U24 peer 59–62,
 * in-app credentials 79–81, owner artifact identity 82). */
const sparseErrorCodes = {
  79: "credentialRequired",
  80: "credentialRejected",
  81: "credentialAttemptsExhausted",
  82: "ownerArtifactMismatch",
  55: "terminalShellUnavailable",
  59: "peerKeyCorrupt",
  60: "peerPinUnknown",
  61: "peerPinMismatch",
  62: "peerAuthRefused",
} as const;

export type PickerProofOwnerErrorCode =
  | Exclude<(typeof wireErrorCodes)[number], undefined>
  | (typeof sparseErrorCodes)[keyof typeof sparseErrorCodes]
  | "versionIncompatible"
  | "profileMismatch"
  | "protocolError";

const jumpStages = [
  undefined,
  "admission",
  "forward",
  "handshake",
  "listing",
  "retirement",
] as const;
type JumpStage = Exclude<(typeof jumpStages)[number], undefined>;
export type JumpFailure = { readonly leg: number; readonly stage: JumpStage };

export const decodeJumpStage = (value: number): JumpStage => jumpStages[value] ?? invalid();

export class PickerProofOwnerError extends Error {
  constructor(
    readonly code: PickerProofOwnerErrorCode,
    readonly jumpFailure?: JumpFailure,
  ) {
    super(`SSH picker proof owner: ${code}`);
    this.name = "PickerProofOwnerError";
  }
}

export const invalid = (): never => {
  throw new PickerProofOwnerError("protocolError");
};
export const bytesValue = (wire: number, reader: WireReader) => {
  requireWireType(wire, 2);
  return reader.bytesValue();
};
export const stringValue = (wire: number, reader: WireReader) => {
  requireWireType(wire, 2);
  return reader.string();
};
export const uintValue = (wire: number, reader: WireReader) => {
  requireWireType(wire, 0);
  return reader.uint();
};
export const boolValue = (wire: number, reader: WireReader) => {
  const value = uintValue(wire, reader);
  if (value !== 0 && value !== 1) return invalid();
  return value === 1;
};

export const decodeOwnerError = (value: number) =>
  wireErrorCodes[value] ?? sparseErrorCodes[value as keyof typeof sparseErrorCodes] ?? invalid();
