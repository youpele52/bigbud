import {
  envelopeTags,
  messageFields,
  type ComputerUseFrame,
  type Field,
  type MessageKind,
  type WireRecord,
} from "./protocol.fields";
import { frameMaximum, type ComputerUseChannel } from "./protocol.profile";
import { validateFrame } from "./protocol.validation";
import {
  decodeField,
  encodeField,
  join,
  requireProtocol,
  varint,
  WireReader,
} from "./protocol.wire";

/** Caller owns aggregate ingress credit and the 5s incomplete-frame deadline.
 * Complete frames only: no socket, child process, replay or implicit activation.
 * Byte fields are copied on decode; encoded inputs must not mutate concurrently.
 */
export function encodeComputerUseFrame(
  frame: ComputerUseFrame,
  channel: ComputerUseChannel,
): Uint8Array {
  requireProtocol(Object.hasOwn(messageFields, frame.kind));
  const fields = messageFields[frame.kind];
  requireProtocol(
    fields && frame.value && typeof frame.value === "object" && !Array.isArray(frame.value),
  );
  const descriptors = Object.getOwnPropertyDescriptors(frame.value);
  requireProtocol(Object.getOwnPropertySymbols(frame.value).length === 0);
  requireProtocol(Object.keys(descriptors).every((name) => Object.hasOwn(fields, name)));
  const parts: Uint8Array[] = [];
  for (const [name, field] of Object.entries(fields)) {
    const descriptor = descriptors[name];
    requireProtocol(descriptor && "value" in descriptor);
    parts.push(...encodeField(field, descriptor.value));
  }
  validateFrame(frame, channel);
  const maximum = frameMaximum(channel);
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const tag = varint(BigInt(envelopeTags[frame.kind] * 8 + 2));
  const length = varint(BigInt(size));
  const total = tag.length + length.length + size;
  requireProtocol(total > 0 && total <= maximum, "length");
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, total);
  // No intermediate full-payload copy for a maximum-size data frame.
  return join([prefix, tag, length, ...parts], maximum + 4);
}

export function decodeComputerUseFrame(
  bytes: Uint8Array,
  channel: ComputerUseChannel,
): ComputerUseFrame {
  requireProtocol(bytes.length >= 4, "length");
  const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
  requireProtocol(
    length > 0 && length <= frameMaximum(channel) && bytes.length === length + 4,
    "length",
  );
  const reader = new WireReader(bytes.subarray(4));
  const [id, wire] = reader.tag();
  requireProtocol(wire === 2);
  const kind = (Object.keys(envelopeTags) as MessageKind[]).find((key) => envelopeTags[key] === id);
  requireProtocol(kind);
  const payload = reader.take();
  requireProtocol(reader.done);
  const fields: Readonly<Record<string, Field>> = messageFields[kind];
  const value: WireRecord = {};
  for (const [name, [, type]] of Object.entries(fields))
    value[name] = type === "b" ? new Uint8Array() : type === "u32" ? 0 : type === "u64" ? "0" : "";
  const seen = new Set<number>();
  const message = new WireReader(payload);
  while (!message.done) {
    const [fieldId, fieldWire] = message.tag();
    const entry = Object.entries(fields).find(([, field]) => field[0] === fieldId);
    requireProtocol(entry && !seen.has(fieldId));
    seen.add(fieldId);
    value[entry[0]] = decodeField(message, fieldWire, entry[1]);
  }
  const frame = { kind, value };
  validateFrame(frame, channel);
  return frame;
}
