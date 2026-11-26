/**
 * U24 production peer enrollment and relay codec (Request 130–136, Reply 76–79).
 *
 * Pairing authority is the owner's own pin store: inspection returns a one-time
 * challenge, only `approvePeerPin` writes a pin, and a relay names nothing but
 * the pairing id. No host, key, user or identity is representable in a relay.
 *
 * @module sshOwnerPickerProof.codec.peerProduction
 */
import { decodeMessage, WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { isExactRemotePath } from "./sshOwnerPickerProof.codec.gitUpload.ts";
import { isPeerEnrollmentTarget } from "./sshOwnerPickerProof.codec.peerEnrollment.ts";
import {
  bytesValue,
  invalid,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
  uintValue,
} from "./sshOwnerPickerProof.codec.wire.ts";

const PAIRING_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const USER = /^[a-z_][a-z0-9_.-]{0,31}$/;
const ED25519_KEY = /^ssh-ed25519 [A-Za-z0-9+/]{68}$/;
const HOST_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const COORDINATOR_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

export type PeerProductionOperation =
  | { readonly kind: "ensurePeerCoordinatorKey" }
  | { readonly kind: "inspectPeerHostKey"; readonly host: string; readonly port: number }
  | {
      readonly kind: "approvePeerPin";
      readonly challenge: Uint8Array;
      readonly pairingId: string;
      readonly user: string;
    }
  | { readonly kind: "revokePeerPin"; readonly pairingId: string }
  | { readonly kind: "peerRelayOpen"; readonly lease: Uint8Array; readonly pairingId: string }
  | { readonly kind: "peerRelayStatus" | "peerRelayClose"; readonly lease: Uint8Array };

export interface PeerProductionCoordinatorKey {
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly algorithm: "ssh-ed25519";
}

export interface PeerProductionHostKey {
  readonly keyType: "ssh-ed25519";
  readonly fingerprint: string;
  readonly publicKey: string;
  /** One-time owner challenge for exactly this host, port and key. */
  readonly challenge: Uint8Array;
}

export interface PeerPin {
  readonly pairingId: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly hostKeyFingerprint: string;
  readonly coordinatorKeyFingerprint: string;
}

export type PeerRelayState = { readonly lease: Uint8Array; readonly pairingId: string } & (
  | { readonly phase: "listening"; readonly socketPath: string }
  | { readonly phase: "exited"; readonly exitCode: number }
  | { readonly phase: "streaming" | "closed" | "lost" | "unconfirmed" }
);

export type PeerProductionOutcome =
  | { readonly kind: "peerCoordinatorKey"; readonly value: PeerProductionCoordinatorKey }
  | { readonly kind: "peerHostKey"; readonly value: PeerProductionHostKey }
  | { readonly kind: "peerPin"; readonly value: PeerPin }
  | { readonly kind: "peerRelay"; readonly value: PeerRelayState };

export const PEER_PRODUCTION_KINDS = [
  "ensurePeerCoordinatorKey",
  "inspectPeerHostKey",
  "approvePeerPin",
  "revokePeerPin",
  "peerRelayOpen",
  "peerRelayStatus",
  "peerRelayClose",
] as const;

const FIELD = {
  ensurePeerCoordinatorKey: 130,
  inspectPeerHostKey: 131,
  approvePeerPin: 132,
  revokePeerPin: 133,
  peerRelayOpen: 134,
  peerRelayStatus: 135,
  peerRelayClose: 136,
} as const;

const refuse = (): never => {
  throw new PickerProofOwnerError("invalidOperands");
};

function pairingId(value: string) {
  return PAIRING_ID.test(value) ? value : refuse();
}

function token(value: Uint8Array) {
  return value.length === PROOF_TOKEN_BYTES ? value : refuse();
}

export function writePeerProduction(writer: WireWriter, operation: PeerProductionOperation) {
  const operands = new WireWriter();
  switch (operation.kind) {
    case "ensurePeerCoordinatorKey":
      break;
    case "inspectPeerHostKey":
      if (!isPeerEnrollmentTarget(operation.host, operation.port)) refuse();
      operands.fieldString(1, operation.host);
      operands.fieldUint(2, operation.port);
      break;
    case "approvePeerPin":
      if (!USER.test(operation.user)) refuse();
      operands.fieldBytes(1, token(operation.challenge));
      operands.fieldString(2, pairingId(operation.pairingId));
      operands.fieldString(3, operation.user);
      break;
    case "revokePeerPin":
      operands.fieldString(1, pairingId(operation.pairingId));
      break;
    case "peerRelayOpen":
      operands.fieldBytes(1, token(operation.lease));
      operands.fieldString(2, pairingId(operation.pairingId));
      break;
    default:
      operands.fieldBytes(1, token(operation.lease));
  }
  writer.fieldRepeatedMessage(FIELD[operation.kind], operands.finish());
}

/** Read one message's fields once each; any repeat or unknown field is invalid. */
function fields(bytes: Uint8Array, allowed: number) {
  const values = new Map<number, string | number | Uint8Array>();
  decodeMessage(bytes, (field, wire, reader) => {
    if (field < 1 || field > allowed || values.has(field)) return invalid();
    values.set(field, wire === 0 ? uintValue(wire, reader) : bytesValue(wire, reader));
  });
  const text = (field: number) => {
    const value = values.get(field);
    return value instanceof Uint8Array
      ? new TextDecoder("utf-8", { fatal: true }).decode(value)
      : "";
  };
  const bytesField = (field: number) => {
    const value = values.get(field);
    return value instanceof Uint8Array ? value : undefined;
  };
  const uint = (field: number) => {
    const value = values.get(field);
    return typeof value === "number" ? value : undefined;
  };
  return { text, bytesField, uint, has: (field: number) => values.has(field) };
}

const RELAY_PHASES = { 2: "streaming", 4: "closed", 5: "lost", 6: "unconfirmed" } as const;

function readRelay(bytes: Uint8Array): PeerRelayState {
  const read = fields(bytes, 5);
  const lease = read.bytesField(1);
  const phase = read.uint(2);
  const exitCode = read.uint(4);
  const id = read.text(5);
  if (lease?.length !== PROOF_TOKEN_BYTES || !PAIRING_ID.test(id)) return invalid();
  const base = { lease, pairingId: id };
  if (phase === 1 && read.has(3) && exitCode === undefined) {
    const socketPath = read.text(3);
    return isExactRemotePath(socketPath) ? { ...base, phase: "listening", socketPath } : invalid();
  }
  if (phase === 3 && exitCode !== undefined && exitCode <= 255 && !read.has(3))
    return { ...base, phase: "exited", exitCode };
  if (read.has(3) || exitCode !== undefined) return invalid();
  const named = phase === undefined ? undefined : RELAY_PHASES[phase as keyof typeof RELAY_PHASES];
  return named ? { ...base, phase: named } : invalid();
}

/** Reply 76 (coordinator key), 77 (presented key + challenge), 78 (pin) or 79 (relay). */
export function readPeerProductionOutcome(
  field: 76 | 77 | 78 | 79,
  bytes: Uint8Array,
): PeerProductionOutcome {
  if (field === 79) return { kind: "peerRelay", value: readRelay(bytes) };
  if (field === 76) {
    const read = fields(bytes, 3);
    const value = {
      publicKey: read.text(1),
      fingerprint: read.text(2),
      algorithm: "ssh-ed25519" as const,
    };
    return ED25519_KEY.test(value.publicKey) &&
      COORDINATOR_FINGERPRINT.test(value.fingerprint) &&
      read.text(3) === "ssh-ed25519"
      ? { kind: "peerCoordinatorKey", value }
      : invalid();
  }
  if (field === 77) {
    const read = fields(bytes, 4);
    const challenge = read.bytesField(4);
    const value = {
      keyType: "ssh-ed25519" as const,
      fingerprint: read.text(2),
      publicKey: read.text(3),
      challenge: challenge ?? new Uint8Array(),
    };
    return read.text(1) === "ssh-ed25519" &&
      HOST_FINGERPRINT.test(value.fingerprint) &&
      ED25519_KEY.test(value.publicKey) &&
      challenge?.length === PROOF_TOKEN_BYTES
      ? { kind: "peerHostKey", value }
      : invalid();
  }
  const read = fields(bytes, 6);
  const value: PeerPin = {
    pairingId: read.text(1),
    host: read.text(2),
    port: read.uint(3) ?? 0,
    user: read.text(4),
    hostKeyFingerprint: read.text(5),
    coordinatorKeyFingerprint: read.text(6),
  };
  return PAIRING_ID.test(value.pairingId) &&
    isPeerEnrollmentTarget(value.host, value.port) &&
    USER.test(value.user) &&
    HOST_FINGERPRINT.test(value.hostKeyFingerprint) &&
    COORDINATOR_FINGERPRINT.test(value.coordinatorKeyFingerprint)
    ? { kind: "peerPin", value }
    : invalid();
}
