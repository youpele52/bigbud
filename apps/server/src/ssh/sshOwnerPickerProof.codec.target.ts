import { isIP } from "node:net";
import { isAbsolute } from "node:path";

import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";
import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";

/**
 * Additive target descriptor (W3.7). The production client sends one per
 * target-scoped request; the owner resolves policy, trust, identity, connector
 * rules and the generation from it. Only these bounded facts cross the wire: no
 * credential bytes, raw config text or caller-chosen transport options.
 *
 * @module sshOwnerPickerProof.codec.target
 */

export interface ProofTargetDescriptorInput {
  readonly targetId: string;
  readonly kind: "alias" | "structured";
  /**
   * IP literal or RFC 1123 DNS name. The owner resolves a name itself at
   * resolution time; this process never resolves it. A CIDR or unspecified
   * address is refused.
   */
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** v1 admits key mode only; agent and password are typed unsupported policy. */
  readonly authMode?: "key" | "agent" | "password";
  /** Absolute literal identity path. */
  readonly identityFile: string;
  /** Absolute literal known-hosts path. */
  readonly knownHostsFile: string;
  readonly hostKeyAlias?: string;
  /** Last observed target generation; empty requests first use. */
  readonly generation?: Uint8Array;
}

export const TARGET_DESCRIPTOR_LIMITS = {
  maxEncodedBytes: 4 * 1024,
  maxTargetIdBytes: 1_024,
  maxUserBytes: 64,
  maxPathBytes: 1_024,
  maxHostKeyAliasBytes: 255,
  maxHostBytes: 253,
} as const;

/** Mirrors the owner's `safe_token(_, 255)` for an explicit known-hosts name. */
const HOST_KEY_ALIAS = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,254}$/;

const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** Mirrors the owner's `parse_host`: a non-unspecified IP literal or a host name. */
export function isDescriptorHost(host: unknown): host is string {
  if (typeof host !== "string" || host.length === 0) return false;
  if (host.length > TARGET_DESCRIPTOR_LIMITS.maxHostBytes) return false;
  if (isIP(host) !== 0) return host !== "0.0.0.0" && host !== "::" && !/^[0:]+$/.test(host);
  const labels = host.split(".");
  // An all-numeric final label would read as a malformed IPv4 literal.
  if (/^[0-9]+$/.test(labels.at(-1) ?? "")) return false;
  return labels.every((label) => HOST_LABEL.test(label));
}

const USER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const hasControl = (value: string) =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

const invalid = () => new PickerProofOwnerError("invalidOperands");

const literalPath = (path: string): boolean =>
  isAbsolute(path) &&
  path.length > 0 &&
  path.length <= TARGET_DESCRIPTOR_LIMITS.maxPathBytes &&
  !path.includes("\0") &&
  /^[A-Za-z0-9._/-]+$/.test(path);

/** Validates every descriptor field before a frame is encoded. */
export function validateTargetDescriptor(input: ProofTargetDescriptorInput): void {
  const generation = input.generation;
  if (
    typeof input.targetId !== "string" ||
    input.targetId.length === 0 ||
    Buffer.byteLength(input.targetId) > TARGET_DESCRIPTOR_LIMITS.maxTargetIdBytes ||
    hasControl(input.targetId) ||
    (input.kind !== "alias" && input.kind !== "structured") ||
    !isDescriptorHost(input.host) ||
    !Number.isInteger(input.port) ||
    input.port < 1 ||
    input.port > 65_535 ||
    !USER_PATTERN.test(input.user) ||
    !literalPath(input.identityFile) ||
    !literalPath(input.knownHostsFile) ||
    input.identityFile === input.knownHostsFile ||
    (input.hostKeyAlias !== undefined && !HOST_KEY_ALIAS.test(input.hostKeyAlias)) ||
    (input.authMode !== undefined &&
      input.authMode !== "key" &&
      input.authMode !== "agent" &&
      input.authMode !== "password") ||
    (generation !== undefined && generation.length !== 0 && generation.length !== 32)
  ) {
    throw invalid();
  }
}

const authModeNumber = (mode: ProofTargetDescriptorInput["authMode"]): number => {
  switch (mode ?? "key") {
    case "key":
      return 1;
    case "agent":
      return 2;
    case "password":
      return 3;
  }
};

/** Writes the descriptor as field 6 of `Request`. */
export function writeTargetDescriptor(writer: WireWriter, input: ProofTargetDescriptorInput) {
  validateTargetDescriptor(input);
  const descriptor = new WireWriter();
  descriptor.fieldString(1, input.targetId);
  descriptor.fieldUint(2, input.kind === "alias" ? 1 : 2);
  descriptor.fieldString(3, input.host);
  descriptor.fieldUint(4, input.port);
  descriptor.fieldString(5, input.user);
  descriptor.fieldUint(6, authModeNumber(input.authMode));
  descriptor.fieldString(7, input.identityFile);
  if (input.hostKeyAlias !== undefined) descriptor.fieldString(8, input.hostKeyAlias);
  descriptor.fieldString(9, input.knownHostsFile);
  if (input.generation !== undefined && input.generation.length > 0) {
    descriptor.fieldBytes(10, input.generation);
  }
  writer.fieldRepeatedMessage(6, descriptor.finish());
}
