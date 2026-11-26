/**
 * Peer enrollment wire codec (T-peer / U9). Only public key metadata and the
 * presented host-key metadata cross this boundary. No private path, passphrase,
 * algorithm selector, credential or pin write is representable.
 *
 * @module sshOwnerPickerProof.codec.peerEnrollment
 */
import { decodeMessage, type WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  bytesValue,
  invalid,
  PickerProofOwnerError,
  stringValue,
} from "./sshOwnerPickerProof.codec.wire.ts";

export const PEER_COORDINATOR_ALGORITHM = "ssh-ed25519" as const;
const COORDINATOR_PUBLIC_KEY = /^ssh-ed25519 ([A-Za-z0-9+/]{68})$/;
const COORDINATOR_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const HOST_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const MAX_PROFILE_BINDING = 64;
const MAX_PUBLIC_KEY = 256;
const OCTET = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export interface ProofEnsurePeerCoordinatorKeyOperation {
  readonly kind: "proofEnsurePeerCoordinatorKey";
}

export interface ProofInspectPeerHostKeyOperation {
  readonly kind: "proofInspectPeerHostKey";
  readonly host: string;
  readonly port: number;
}

export type ProofPeerEnrollmentOperation =
  | ProofEnsurePeerCoordinatorKeyOperation
  | ProofInspectPeerHostKeyOperation;

/** Public half only. The private key never leaves the owner profile state. */
export interface PeerCoordinatorKeyMetadata {
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly algorithm: typeof PEER_COORDINATOR_ALGORITHM;
  readonly profileBinding: Uint8Array;
}

/** Metadata about the key the endpoint presented now; no pin was saved. */
export interface PeerHostKeyMetadata {
  readonly keyType: typeof PEER_COORDINATOR_ALGORITHM;
  readonly fingerprint: string;
  /** `<type> <base64>` presented key, used only to build the pin a user confirms. */
  readonly publicKey: string;
}

function isIpv6Literal(host: string): boolean {
  if (!host.includes(":")) return false;
  const parts = host.split("::");
  if (parts.length > 2) return false;
  const groups = [...(parts[0]?.split(":") ?? []), ...(parts[1]?.split(":") ?? [])];
  if (parts.length === 2 ? groups.length > 7 : groups.length !== 8) return false;
  return groups.every((group) => group === "" || /^[0-9A-Fa-f]{1,4}$/.test(group));
}

function isIpv4Literal(host: string): boolean {
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) => OCTET.test(part));
}

/** A bare IP literal or DNS name. No user, port, option, path or shell syntax. */
export function isPeerEnrollmentTarget(host: string, port: number): boolean {
  if (
    !host ||
    host.length > 253 ||
    host.startsWith("-") ||
    /[\p{Cc} @/\\]/u.test(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  )
    return false;
  if (isIpv6Literal(host)) return true;
  if (host.includes(":")) return false;
  if (isIpv4Literal(host)) return true;
  return host
    .split(".")
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        !label.startsWith("-") &&
        !label.endsWith("-") &&
        /^[A-Za-z0-9-]+$/.test(label),
    );
}

export function isValidPeerCoordinatorKey(value: PeerCoordinatorKeyMetadata): boolean {
  return (
    COORDINATOR_PUBLIC_KEY.test(value.publicKey) &&
    COORDINATOR_FINGERPRINT.test(value.fingerprint) &&
    value.algorithm === PEER_COORDINATOR_ALGORITHM &&
    value.profileBinding.length > 0 &&
    value.profileBinding.length <= MAX_PROFILE_BINDING
  );
}

export function isValidPeerHostKey(value: PeerHostKeyMetadata): boolean {
  return (
    value.keyType === PEER_COORDINATOR_ALGORITHM &&
    HOST_FINGERPRINT.test(value.fingerprint) &&
    new RegExp(`^${PEER_COORDINATOR_ALGORITHM} [A-Za-z0-9+/]{68}$`).test(value.publicKey)
  );
}

export function writeProofPeerEnrollment(
  writer: WireWriter,
  operands: WireWriter,
  operation: ProofPeerEnrollmentOperation,
): void {
  if (operation.kind === "proofEnsurePeerCoordinatorKey") {
    writer.fieldRepeatedMessage(71, operands.finish());
    return;
  }
  if (!isPeerEnrollmentTarget(operation.host, operation.port))
    throw new PickerProofOwnerError("invalidOperands");
  operands.fieldString(1, operation.host);
  operands.fieldUint(2, operation.port);
  writer.fieldRepeatedMessage(72, operands.finish());
}

export function readPeerCoordinatorKey(bytes: Uint8Array): PeerCoordinatorKeyMetadata {
  let publicKey = "",
    fingerprint = "",
    algorithm = "",
    profileBinding: Uint8Array | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1) publicKey = stringValue(wire, reader);
    else if (field === 2) fingerprint = stringValue(wire, reader);
    else if (field === 3) algorithm = stringValue(wire, reader);
    else if (field === 4) profileBinding = bytesValue(wire, reader);
    else reader.skip(wire);
  });
  if (!publicKey || publicKey.length > MAX_PUBLIC_KEY || profileBinding === undefined)
    return invalid();
  const key: PeerCoordinatorKeyMetadata = {
    publicKey,
    fingerprint,
    algorithm: algorithm as typeof PEER_COORDINATOR_ALGORITHM,
    profileBinding,
  };
  return isValidPeerCoordinatorKey(key) ? key : invalid();
}

export function readPeerHostKey(bytes: Uint8Array): PeerHostKeyMetadata {
  let keyType = "",
    fingerprint = "",
    publicKey = "";
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1) keyType = stringValue(wire, reader);
    else if (field === 2) fingerprint = stringValue(wire, reader);
    else if (field === 3) publicKey = stringValue(wire, reader);
    else reader.skip(wire);
  });
  const key: PeerHostKeyMetadata = {
    keyType: keyType as typeof PEER_COORDINATOR_ALGORITHM,
    fingerprint,
    publicKey,
  };
  return isValidPeerHostKey(key) ? key : invalid();
}
