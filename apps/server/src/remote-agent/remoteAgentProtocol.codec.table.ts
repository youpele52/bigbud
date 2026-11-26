import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import { decodeMessage, requireWireType, WireWriter } from "./remoteAgentProtocol.codec.wire.ts";

/**
 * Table-driven protobuf codec for flat frame families (paste staging, search, PTY lifecycle).
 * `uint` also covers enums and non-negative `int64` fields; `strings` is a repeated string;
 * `repeated` is a repeated embedded message; `message` is a singular embedded message that is
 * always encoded (as prost does for `Some`) and decodes to defaults when absent.
 */
export type TableFieldKind =
  | "string"
  | "uint"
  | "bool"
  | "bytes"
  | "strings"
  | { readonly repeated: TableSchema }
  | { readonly message: TableSchema };
export type TableSchema = ReadonlyArray<
  readonly [field: number, key: string, kind: TableFieldKind]
>;
export type TableFrames<Type extends string> = ReadonlyArray<
  readonly [frameField: number, type: Type, schema: TableSchema]
>;

const emptyValue = (kind: TableFieldKind): unknown =>
  kind === "string"
    ? ""
    : kind === "uint"
      ? 0
      : kind === "bool"
        ? false
        : kind === "bytes"
          ? new Uint8Array()
          : typeof kind === "object" && "message" in kind
            ? decodeTableMessage(kind.message, new Uint8Array())
            : [];

export function encodeTableMessage(
  schema: TableSchema,
  value: Record<string, unknown>,
): Uint8Array {
  const writer = new WireWriter();
  for (const [field, key, kind] of schema) {
    const entry = value[key];
    if (kind === "string") writer.fieldString(field, entry as string);
    else if (kind === "uint") writer.fieldUint(field, entry as number);
    else if (kind === "bool") writer.fieldBool(field, entry as boolean);
    else if (kind === "bytes") writer.fieldBytes(field, entry as Uint8Array);
    else if (kind === "strings") {
      for (const element of entry as ReadonlyArray<string>)
        writer.fieldRepeatedString(field, element);
    } else if ("message" in kind) {
      writer.fieldRepeatedMessage(
        field,
        encodeTableMessage(kind.message, entry as Record<string, unknown>),
      );
    } else {
      for (const element of entry as ReadonlyArray<Record<string, unknown>>) {
        // Repeated elements keep their slot even when every field is a default (as prost does).
        writer.fieldRepeatedMessage(field, encodeTableMessage(kind.repeated, element));
      }
    }
  }
  return writer.finish();
}

export function decodeTableMessage(
  schema: TableSchema,
  bytes: Uint8Array,
): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const [, key, kind] of schema) value[key] = emptyValue(kind);
  decodeMessage(bytes, (field, wireType, reader) => {
    const entry = schema.find(([candidate]) => candidate === field);
    if (!entry) return reader.skip(wireType);
    const [, key, kind] = entry;
    requireWireType(wireType, kind === "uint" || kind === "bool" ? 0 : 2);
    if (kind === "string") value[key] = reader.string();
    else if (kind === "uint") value[key] = reader.uint();
    else if (kind === "bool") value[key] = reader.uint() !== 0;
    else if (kind === "bytes") value[key] = reader.bytesValue();
    else if (kind === "strings") (value[key] as unknown[]).push(reader.string());
    else if ("message" in kind) value[key] = decodeTableMessage(kind.message, reader.bytesValue());
    else (value[key] as unknown[]).push(decodeTableMessage(kind.repeated, reader.bytesValue()));
  });
  return value;
}

/**
 * Additive scalar fields on an existing message: encodes only the listed fields (absent keys use
 * protobuf defaults), to be appended after the message's legacy, lower-numbered fields.
 */
export function encodeTableExtension(schema: TableSchema, value: object): Uint8Array {
  const record = value as Record<string, unknown>;
  const filled: Record<string, unknown> = {};
  for (const [, key, kind] of schema) filled[key] = record[key] ?? emptyValue(kind);
  return encodeTableMessage(schema, filled);
}

/**
 * Decodes additive scalar (`string`, `uint`, `bool`) fields, keeping only non-default values so
 * frames from older peers decode exactly as before.
 */
export function decodeTableExtension(
  schema: TableSchema,
  bytes: Uint8Array,
): Record<string, unknown> {
  const decoded = decodeTableMessage(schema, bytes);
  const value: Record<string, unknown> = {};
  for (const [, key] of schema) {
    const entry = decoded[key];
    if (entry !== "" && entry !== 0 && entry !== false) value[key] = entry;
  }
  return value;
}

export function encodeTableFrame<Type extends string>(
  frames: TableFrames<Type>,
  frame: RemoteAgentFrame,
): { readonly field: number; readonly value: Uint8Array } | undefined {
  const entry = frames.find(([, type]) => type === frame.type);
  if (!entry) return undefined;
  const [field, , schema] = entry;
  return {
    field,
    value: encodeTableMessage(schema, frame.value as unknown as Record<string, unknown>),
  };
}

export function decodeTableFrame<Type extends string>(
  frames: TableFrames<Type>,
  field: number,
  bytes: Uint8Array,
): { readonly type: Type; readonly value: Record<string, unknown> } | undefined {
  const entry = frames.find(([frameField]) => frameField === field);
  if (!entry) return undefined;
  const [, type, schema] = entry;
  return { type, value: decodeTableMessage(schema, bytes) };
}
