import { decodeMessage, WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { isExactRemotePath } from "./sshOwnerPickerProof.codec.gitUpload.ts";
import {
  boolValue,
  bytesValue,
  EMPTY,
  invalid,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
  stringValue,
  uintValue,
} from "./sshOwnerPickerProof.codec.wire.ts";

/**
 * In-app SSH password and key-passphrase entry (v1.credential.proto; Request 190–193,
 * Reply 106–107). No secret is ever part of an operation: the caller writes it to the
 * owner-made per-lease socket that `credentialUnlockOpen` returns.
 *
 * @module sshOwnerPickerProof.codec.credential
 */
export type CredentialKind = "none" | "password" | "keyPassphrase";

export type CredentialOperation =
  | { readonly kind: "inspectCredential" | "credentialLock" }
  | {
      readonly kind: "credentialUnlockOpen";
      readonly lease: Uint8Array;
      readonly credential: Exclude<CredentialKind, "none">;
    }
  | { readonly kind: "credentialUnlockCommit"; readonly lease: Uint8Array };

export interface CredentialState {
  readonly credential: CredentialKind;
  readonly unlocked: boolean;
  readonly attemptsRemaining: number;
  /** For a key passphrase, the identity file the prompt names. */
  readonly identity?: string;
}

export interface CredentialUnlockLease {
  readonly lease: Uint8Array;
  readonly socketPath: string;
}

export type CredentialOutcome =
  | { readonly kind: "credentialState"; readonly value: CredentialState }
  | { readonly kind: "credentialUnlockLease"; readonly value: CredentialUnlockLease };

const KINDS = ["none", "password", "keyPassphrase"] as const;
const WIRE_KIND = { none: 1, password: 2, keyPassphrase: 3 } as const;
const MAX_ATTEMPTS = 3;

const lease = (bytes: Uint8Array) => {
  if (bytes.length !== PROOF_TOKEN_BYTES) throw new PickerProofOwnerError("invalidOperands");
  return bytes;
};

const CREDENTIAL_KINDS: ReadonlySet<string> = new Set([
  "inspectCredential",
  "credentialUnlockOpen",
  "credentialUnlockCommit",
  "credentialLock",
]);

export function isCredentialOperation(operation: {
  readonly kind: string;
}): operation is CredentialOperation {
  return CREDENTIAL_KINDS.has(operation.kind);
}

export function writeCredential(writer: WireWriter, operation: CredentialOperation): void {
  const operands = new WireWriter();
  switch (operation.kind) {
    case "inspectCredential":
      writer.fieldRepeatedMessage(190, EMPTY);
      return;
    case "credentialUnlockOpen":
      operands.fieldBytes(1, lease(operation.lease));
      operands.fieldUint(2, WIRE_KIND[operation.credential]);
      writer.fieldRepeatedMessage(191, operands.finish());
      return;
    case "credentialUnlockCommit":
      operands.fieldBytes(1, lease(operation.lease));
      writer.fieldRepeatedMessage(192, operands.finish());
      return;
    case "credentialLock":
      writer.fieldRepeatedMessage(193, EMPTY);
      return;
  }
}

function readState(bytes: Uint8Array): CredentialState {
  let kind: number | undefined;
  let unlocked: boolean | undefined;
  let attempts: number | undefined;
  let identity: string | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1 && kind === undefined) kind = uintValue(wire, reader);
    else if (field === 2 && unlocked === undefined) unlocked = boolValue(wire, reader);
    else if (field === 3 && attempts === undefined) attempts = uintValue(wire, reader);
    else if (field === 4 && identity === undefined) identity = stringValue(wire, reader);
    else return invalid();
  });
  const credential = kind === undefined ? undefined : KINDS[kind - 1];
  const remaining = attempts ?? 0;
  if (!credential || remaining > MAX_ATTEMPTS) return invalid();
  if (identity !== undefined && (credential !== "keyPassphrase" || !isExactRemotePath(identity)))
    return invalid();
  return {
    credential,
    unlocked: unlocked ?? false,
    attemptsRemaining: remaining,
    ...(identity === undefined ? {} : { identity }),
  };
}

function readLease(bytes: Uint8Array): CredentialUnlockLease {
  let token: Uint8Array | undefined;
  let socketPath: string | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1 && token === undefined) token = bytesValue(wire, reader);
    else if (field === 2 && socketPath === undefined) socketPath = stringValue(wire, reader);
    else return invalid();
  });
  if (token?.length !== PROOF_TOKEN_BYTES || !socketPath || !isExactRemotePath(socketPath))
    return invalid();
  return { lease: token, socketPath };
}

/** Reply 106 (credential state) and 107 (entry socket). */
export function readCredentialOutcome(field: 106 | 107, bytes: Uint8Array): CredentialOutcome {
  return field === 106
    ? { kind: "credentialState", value: readState(bytes) }
    : { kind: "credentialUnlockLease", value: readLease(bytes) };
}
