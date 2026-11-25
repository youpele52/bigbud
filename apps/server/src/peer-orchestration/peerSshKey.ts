/**
 * Coordinator peer key handling (D10, WP-8C, T-peer / U9).
 *
 * The dedicated ed25519 coordinator identity is provisioned by the Rust SSH
 * owner, never by a TypeScript `ssh-keygen` launch. Only its public half is
 * authorized on workers. The fingerprint bound into a grant is `sha256:` plus
 * the hex sha256 of the decoded public key blob.
 *
 * @module peerSshKey
 */
import { createHash } from "node:crypto";

export interface PeerPublicKey {
  readonly type: "ssh-ed25519";
  readonly base64: string;
  readonly fingerprint: string;
}

/** Public metadata returned by the owner. No private material crosses this port. */
export interface PeerCoordinatorKeyMetadata {
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly algorithm: "ssh-ed25519";
  readonly profileBinding: Uint8Array;
}

/** Owner port for the profile-bound coordinator identity. */
export interface PeerCoordinatorKeyOwner {
  ensurePeerCoordinatorKey(): Promise<PeerCoordinatorKeyMetadata>;
}

/** The selected owner is required; there is no TypeScript key-generation fallback. */
export class PeerEnrollmentOwnerUnavailableError extends Error {
  readonly code = "key-unavailable" as const;
  constructor(message = "The selected SSH owner must provision the peer coordinator key.") {
    super(message);
    this.name = "PeerEnrollmentOwnerUnavailableError";
  }
}

export class PeerEnrollmentOwnerMismatchError extends Error {
  readonly code = "key-unavailable" as const;
  constructor(message = "The SSH owner returned inconsistent coordinator key metadata.") {
    super(message);
    this.name = "PeerEnrollmentOwnerMismatchError";
  }
}

/** Accepts exactly `ssh-ed25519 <base64> [comment]`; the comment is discarded. */
export function parsePeerPublicKey(line: string): PeerPublicKey {
  const trimmed = line.trim();
  const [type, base64, ...rest] = trimmed.split(/\s+/);
  if (
    /[\r\n]/.test(trimmed) ||
    type !== "ssh-ed25519" ||
    !base64 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) ||
    rest.join(" ").length > 256
  )
    throw new Error("The peer key must be a single ssh-ed25519 public key.");
  const blob = Buffer.from(base64, "base64");
  // string "ssh-ed25519" (4 + 11 bytes) then string key (4 + 32 bytes).
  if (
    blob.length !== 51 ||
    blob.readUInt32BE(0) !== 11 ||
    blob.subarray(4, 15).toString("latin1") !== "ssh-ed25519" ||
    blob.readUInt32BE(15) !== 32 ||
    blob.toString("base64") !== base64
  )
    throw new Error("The peer key is not a well-formed ssh-ed25519 public key.");
  return {
    type,
    base64,
    fingerprint: `sha256:${createHash("sha256").update(blob).digest("hex")}`,
  };
}

/** One pinned host key: `<type> <base64>` (as in a `.pub` or known-hosts line). */
export function parsePinnedHostKey(value: string): string {
  const [type, base64, ...rest] = value.trim().split(/\s+/);
  if (
    rest.length > 1 ||
    !type ||
    !/^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa|rsa-sha2-(256|512))$/.test(type) ||
    !base64 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
  )
    throw new Error("The pinned host key must be `<type> <base64>`.");
  return `${type} ${base64}`;
}

/**
 * Ask the owner for its dedicated coordinator key and re-verify the returned
 * public metadata locally. Idempotence, corruption refusal and profile binding
 * are owner responsibilities; the caller only sees public material.
 */
export async function ensureCoordinatorPeerKey(
  owner: PeerCoordinatorKeyOwner | undefined,
): Promise<{
  readonly publicKey: PeerPublicKey;
  /** `<type> <base64> bigbud-peer` for display and the worker grant command. */
  readonly publicKeyLine: string;
  readonly fingerprint: string;
}> {
  if (!owner) throw new PeerEnrollmentOwnerUnavailableError();
  const metadata = await owner.ensurePeerCoordinatorKey();
  const publicKey = parsePeerPublicKey(metadata.publicKey);
  if (
    metadata.algorithm !== "ssh-ed25519" ||
    metadata.fingerprint !== publicKey.fingerprint ||
    metadata.profileBinding.length === 0
  )
    throw new PeerEnrollmentOwnerMismatchError();
  return {
    publicKey,
    publicKeyLine: `${publicKey.type} ${publicKey.base64} bigbud-peer`,
    fingerprint: publicKey.fingerprint,
  };
}
