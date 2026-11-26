import type { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { decodeMessage } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { EMPTY, invalid, stringValue } from "./sshOwnerPickerProof.codec.wire.ts";

/**
 * W7 remote system stats: Request 180 `sample_system_status` has no operands;
 * Reply 101 carries the owner recipe's sectioned text (at most 512 KiB, which
 * must end at its END marker). The client never sends a command.
 */
export type SystemStatusOperation = { readonly kind: "sampleSystemStatus" };
export type SystemStatusOutcome = { readonly kind: "systemStatusSample"; readonly value: string };

export const SYSTEM_STATUS_REPLY_FIELD = 101;
const MAX_SAMPLE_BYTES = 512 * 1024;
// The owner decodes lossily, so a full sample may grow by up to 3x in UTF-8.
const MAX_SAMPLE_WIRE_BYTES = 3 * MAX_SAMPLE_BYTES;

export function isSystemStatusOperation<O extends { readonly kind: string }>(
  operation: O,
): operation is Extract<O, SystemStatusOperation> {
  return operation.kind === "sampleSystemStatus";
}

export function writeSystemStatusOperation(writer: WireWriter) {
  writer.fieldRepeatedMessage(180, EMPTY);
}

export function readSystemStatusOutcome(bytes: Uint8Array): SystemStatusOutcome {
  let sections: string | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field !== 1 || sections !== undefined) return invalid();
    sections = stringValue(wire, reader);
  });
  if (
    sections === undefined ||
    Buffer.byteLength(sections) > MAX_SAMPLE_WIRE_BYTES ||
    !/^###END###\r?$/m.test(sections)
  )
    return invalid();
  return { kind: "systemStatusSample", value: sections };
}
