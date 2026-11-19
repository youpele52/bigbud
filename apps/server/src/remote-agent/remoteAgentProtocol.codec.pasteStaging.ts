import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import type { RemoteAgentPasteStagingFrame } from "./remoteAgentProtocol.pasteStaging.ts";
import { decodeMessage, requireWireType, WireWriter } from "./remoteAgentProtocol.codec.wire.ts";

type FieldKind = "string" | "uint" | "bool" | "bytes";
type Schema = ReadonlyArray<readonly [field: number, key: string, kind: FieldKind]>;
type FrameType = RemoteAgentPasteStagingFrame["type"];

/** Field tables mirror `protocol/remote-agent/paste_staging.proto`; frame numbers are 66-73. */
const FRAMES: ReadonlyArray<readonly [frameField: number, type: FrameType, schema: Schema]> = [
  [
    66,
    "pasteStageBeginRequest",
    [
      [1, "requestId", "string"],
      [2, "scope", "string"],
      [3, "uploadId", "string"],
      [4, "totalBytes", "uint"],
      [5, "extension", "string"],
      [6, "imageMimeType", "string"],
    ],
  ],
  [
    67,
    "pasteStageBeginResponse",
    [
      [1, "requestId", "string"],
      [2, "uploadId", "string"],
      [3, "accepted", "bool"],
      [4, "maxChunkBytes", "uint"],
      [5, "errorCode", "string"],
      [6, "errorMessage", "string"],
    ],
  ],
  [
    68,
    "pasteStageChunkRequest",
    [
      [1, "requestId", "string"],
      [2, "uploadId", "string"],
      [3, "offset", "uint"],
      [4, "data", "bytes"],
    ],
  ],
  [
    69,
    "pasteStageChunkResponse",
    [
      [1, "requestId", "string"],
      [2, "uploadId", "string"],
      [3, "receivedBytes", "uint"],
      [4, "errorCode", "string"],
      [5, "errorMessage", "string"],
    ],
  ],
  [
    70,
    "pasteStageCommitRequest",
    [
      [1, "requestId", "string"],
      [2, "uploadId", "string"],
      [3, "sha256", "bytes"],
    ],
  ],
  [
    71,
    "pasteStageCommitResponse",
    [
      [1, "requestId", "string"],
      [2, "uploadId", "string"],
      [3, "path", "string"],
      [4, "clipboard", "string"],
      [5, "errorCode", "string"],
      [6, "errorMessage", "string"],
    ],
  ],
  [
    72,
    "pasteStageDiscardRequest",
    [
      [1, "requestId", "string"],
      [2, "scope", "string"],
      [3, "uploadId", "string"],
    ],
  ],
  [
    73,
    "pasteStageDiscardResponse",
    [
      [1, "requestId", "string"],
      [2, "removed", "uint"],
      [3, "errorCode", "string"],
      [4, "errorMessage", "string"],
    ],
  ],
];

const emptyValue = (kind: FieldKind) =>
  kind === "string" ? "" : kind === "uint" ? 0 : kind === "bool" ? false : new Uint8Array();

function encodeMessage(schema: Schema, value: Record<string, unknown>): Uint8Array {
  const writer = new WireWriter();
  for (const [field, key, kind] of schema) {
    const entry = value[key];
    if (kind === "string") writer.fieldString(field, entry as string);
    else if (kind === "uint") writer.fieldUint(field, entry as number);
    else if (kind === "bool") writer.fieldBool(field, entry as boolean);
    else writer.fieldBytes(field, entry as Uint8Array);
  }
  return writer.finish();
}

function decodeFields(schema: Schema, bytes: Uint8Array): Record<string, unknown> {
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
    else value[key] = reader.bytesValue();
  });
  return value;
}

export function encodePasteStagingFrame(
  frame: RemoteAgentFrame,
): { readonly field: number; readonly value: Uint8Array } | undefined {
  const entry = FRAMES.find(([, type]) => type === frame.type);
  if (!entry) return undefined;
  const [field, , schema] = entry;
  return { field, value: encodeMessage(schema, frame.value as unknown as Record<string, unknown>) };
}

export function decodePasteStagingFrame(
  field: number,
  bytes: Uint8Array,
): RemoteAgentFrame | undefined {
  const entry = FRAMES.find(([frameField]) => frameField === field);
  if (!entry) return undefined;
  const [, type, schema] = entry;
  return { type, value: decodeFields(schema, bytes) } as unknown as RemoteAgentPasteStagingFrame;
}
