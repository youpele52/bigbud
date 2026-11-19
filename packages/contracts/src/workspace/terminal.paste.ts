import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "../core/baseSchemas";
import { DEFAULT_TERMINAL_ID } from "../constants/terminal.constant";

/** Bytes per `chunk` call before base64; well under the WebSocket and agent frame limits. */
export const TERMINAL_PASTE_CHUNK_BYTES = 256 * 1024;
const TERMINAL_PASTE_CHUNK_BASE64_MAX = Math.ceil(TERMINAL_PASTE_CHUNK_BYTES / 3) * 4;

const UploadId = Schema.String.check(Schema.isPattern(/^[a-z0-9]{16,64}$/));
const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Base64Chunk = Schema.String.check(Schema.isMaxLength(TERMINAL_PASTE_CHUNK_BASE64_MAX)).check(
  Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
);

/**
 * Stage one pasted or dropped file on the machine that runs the terminal and return its absolute
 * path there. The server derives the machine from the terminal session, never from the client.
 */
export const TerminalPasteStageBeginInput = Schema.Struct({
  op: Schema.Literal("begin"),
  threadId: TrimmedNonEmptyString,
  terminalId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
    Schema.withDecodingDefault(() => DEFAULT_TERMINAL_ID),
  ),
  expectedGeneration: Schema.optional(TrimmedNonEmptyString),
  /** Display name only; the staged name is random. Used for the extension when no magic match. */
  fileName: Schema.String.check(Schema.isMaxLength(512)),
  mimeType: Schema.String.check(Schema.isMaxLength(255)),
  byteLength: PositiveInt,
});

export const TerminalPasteStageInput = Schema.Union([
  TerminalPasteStageBeginInput,
  Schema.Struct({
    op: Schema.Literal("chunk"),
    uploadId: UploadId,
    offset: NonNegativeInt,
    data: Base64Chunk,
  }),
  Schema.Struct({
    op: Schema.Literal("commit"),
    uploadId: UploadId,
    /** Optional client digest (insecure origins have no WebCrypto); the server always hashes. */
    sha256: Schema.optional(Sha256Hex),
  }),
  Schema.Struct({ op: Schema.Literal("abort"), uploadId: UploadId }),
]);
export type TerminalPasteStageInput = Schema.Codec.Encoded<typeof TerminalPasteStageInput>;

export const TerminalPasteHost = Schema.Literals(["local", "remote"]);
export type TerminalPasteHost = typeof TerminalPasteHost.Type;

export const TerminalPasteStageResult = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("begin"),
    uploadId: UploadId,
    chunkBytes: PositiveInt,
    host: TerminalPasteHost,
    /** The machine the file lands on, for the upload toast. */
    hostLabel: Schema.String,
  }),
  Schema.Struct({ op: Schema.Literal("chunk"), receivedBytes: NonNegativeInt }),
  Schema.Struct({
    op: Schema.Literal("commit"),
    /** Absolute path on the terminal's machine. */
    path: Schema.String,
    host: TerminalPasteHost,
    hostLabel: Schema.String,
    /** Remote only: whether the remote clipboard now also holds the image. */
    clipboard: Schema.Literals(["set", "unavailable", "skipped"]),
  }),
  Schema.Struct({ op: Schema.Literal("abort") }),
]);
export type TerminalPasteStageResult = typeof TerminalPasteStageResult.Type;

export const TerminalPasteStageErrorCode = Schema.Literals([
  "tooLarge",
  "terminalChanged",
  "agentUpdateRequired",
  "remoteAgentRequired",
  "unsupportedTarget",
  "invalidUpload",
  "integrity",
  "storageFailed",
  "unavailable",
]);
export type TerminalPasteStageErrorCode = typeof TerminalPasteStageErrorCode.Type;

export class TerminalPasteStageError extends Schema.TaggedErrorClass<TerminalPasteStageError>()(
  "TerminalPasteStageError",
  {
    code: TerminalPasteStageErrorCode,
    detail: Schema.String,
  },
) {
  override get message() {
    return this.detail;
  }
}
