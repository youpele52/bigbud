import { decodeMessage, WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { readCredentialOutcome } from "./sshOwnerPickerProof.codec.credential.ts";
import { boolValue, EMPTY, invalid, uintValue } from "./sshOwnerPickerProof.codec.wire.ts";

/**
 * Drain-time owner shutdown (v1.owner_shutdown.proto; Request 194, Reply 108). Owner-wide,
 * no operands: the owner closes every master and lease, clears its attach record and exits.
 *
 * @module sshOwnerPickerProof.codec.ownerShutdown
 */
export type OwnerShutdownOperation = { readonly kind: "ownerShutdown" };

export interface OwnerShutdownReport {
  readonly mastersClosed: number;
  readonly leasesClosed: number;
  readonly attachCleared: boolean;
}

export const isOwnerShutdownOperation = (operation: {
  readonly kind: string;
}): operation is OwnerShutdownOperation => operation.kind === "ownerShutdown";

export function writeOwnerShutdown(writer: WireWriter): void {
  writer.fieldRepeatedMessage(194, EMPTY);
}

function readReport(bytes: Uint8Array): OwnerShutdownReport {
  let masters: number | undefined;
  let leases: number | undefined;
  let cleared: boolean | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1 && masters === undefined) masters = uintValue(wire, reader);
    else if (field === 2 && leases === undefined) leases = uintValue(wire, reader);
    else if (field === 3 && cleared === undefined) cleared = boolValue(wire, reader);
    else return invalid();
  });
  return {
    mastersClosed: masters ?? 0,
    leasesClosed: leases ?? 0,
    attachCleared: cleared ?? false,
  };
}

/** Reply 106–107 (in-app credentials) and 108 (owner shutdown report). */
export function readCredentialOrShutdownOutcome(field: 106 | 107 | 108, bytes: Uint8Array) {
  return field === 108
    ? ({ kind: "ownerShutdown", value: readReport(bytes) } as const)
    : readCredentialOutcome(field, bytes);
}
