import { OWNER_MAJOR, OWNER_MINOR } from "./sshOwnerPickerProof.codec.ts";
import { SshOwnerClientError } from "./sshOwnerProductionClient.errors.ts";

/**
 * Protocol v1 negotiation for the production owner client.
 *
 * The v1 `HelloAccepted` carries the negotiated major/minor and the owner epoch;
 * capabilities and limits are the compiled contract for that exact version, not
 * a new wire message. An owner that accepts a different version is typed-closed
 * before any request is admitted.
 *
 * @module sshOwnerProductionClient.negotiate
 */

export const SSH_OWNER_PROTOCOL = { major: OWNER_MAJOR, minor: OWNER_MINOR } as const;

export const SSH_OWNER_V1_CAPABILITIES = [
  "wire.v1",
  "storage.hydrate",
  "attach.capability",
  "lifecycle.detach",
  "lifecycle.reap",
] as const;

export type SshOwnerClientCapability = (typeof SSH_OWNER_V1_CAPABILITIES)[number];

/** Capabilities this client cannot start without. */
export const SSH_OWNER_REQUIRED_CAPABILITIES: readonly SshOwnerClientCapability[] = [
  "wire.v1",
  "storage.hydrate",
  "attach.capability",
  "lifecycle.detach",
];

export const SSH_OWNER_WIRE_LIMITS = {
  /** `sshOwnerPickerProof.pipe.ts` refuses a larger client frame at the boundary. */
  clientToOwnerFrameBytes: 64 * 1024,
  ownerToClientFrameBytes: 8 * 1024 * 1024,
  /** The handshake must finish inside this bound or the child is killed. */
  startupDeadlineMs: 10_000,
  exchangeMs: 20_000,
  /** Hello -> storage hydrate -> snapshot -> accepted. */
  handshakeFrames: 3,
} as const;

export interface SshOwnerNegotiationInput {
  readonly major: number;
  readonly minor: number;
  readonly ownerEpoch: Uint8Array;
  /** Test seam for a build that advertises a reduced or newer capability set. */
  readonly advertisedCapabilities?: ReadonlyArray<string>;
  readonly requiredCapabilities?: ReadonlyArray<string>;
}

export interface SshOwnerNegotiated {
  readonly major: typeof OWNER_MAJOR;
  readonly minor: typeof OWNER_MINOR;
  readonly capabilities: ReadonlyArray<string>;
  readonly ownerEpoch: Uint8Array;
  readonly limits: typeof SSH_OWNER_WIRE_LIMITS;
}

const capabilitiesForVersion = (major: number, minor: number): ReadonlyArray<string> | undefined =>
  major === SSH_OWNER_PROTOCOL.major && minor === SSH_OWNER_PROTOCOL.minor
    ? SSH_OWNER_V1_CAPABILITIES
    : undefined;

/**
 * Validates the accepted version, epoch and capability set. Any mismatch is a
 * typed failure; the caller must shut the child down.
 */
export function negotiateSshOwnerV1(input: SshOwnerNegotiationInput): SshOwnerNegotiated {
  if (input.major !== SSH_OWNER_PROTOCOL.major || input.minor !== SSH_OWNER_PROTOCOL.minor) {
    throw new SshOwnerClientError(
      "version-incompatible",
      `The SSH owner negotiated protocol ${input.major}.${input.minor}; this backend requires ${SSH_OWNER_PROTOCOL.major}.${SSH_OWNER_PROTOCOL.minor}.`,
    );
  }
  if (input.ownerEpoch.length !== 32) {
    throw new SshOwnerClientError(
      "wire-protocol-invalid",
      "The SSH owner did not report a 32-byte owner epoch.",
    );
  }
  const capabilities =
    input.advertisedCapabilities ?? capabilitiesForVersion(input.major, input.minor);
  if (!capabilities) {
    throw new SshOwnerClientError(
      "version-incompatible",
      "The SSH owner advertised no capability set for the negotiated protocol version.",
    );
  }
  const required = input.requiredCapabilities ?? SSH_OWNER_REQUIRED_CAPABILITIES;
  const missing = required.filter((capability) => !capabilities.includes(capability));
  if (missing.length > 0) {
    throw new SshOwnerClientError(
      "capability-missing",
      `The SSH owner is missing required capabilities: ${missing.join(", ")}.`,
    );
  }
  return {
    major: SSH_OWNER_PROTOCOL.major,
    minor: SSH_OWNER_PROTOCOL.minor,
    capabilities: [...capabilities],
    ownerEpoch: Uint8Array.from(input.ownerEpoch),
    limits: SSH_OWNER_WIRE_LIMITS,
  };
}

/** Rejects a declared frame size before it can be allocated or forwarded. */
export function assertSshOwnerFrameSize(direction: "client" | "owner", bytes: number): void {
  const limit =
    direction === "client"
      ? SSH_OWNER_WIRE_LIMITS.clientToOwnerFrameBytes
      : SSH_OWNER_WIRE_LIMITS.ownerToClientFrameBytes;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > limit) {
    throw new SshOwnerClientError(
      "wire-limit-exceeded",
      `The SSH owner ${direction} frame size ${bytes} is outside the ${limit}-byte limit.`,
    );
  }
}
