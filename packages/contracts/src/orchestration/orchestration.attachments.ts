import { Schema } from "effect";
import { NonNegativeInt, TrimmedNonEmptyString } from "../core/baseSchemas";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "./orchestration.provider";

const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;
const PROVIDER_SEND_TURN_MAX_FILE_DATA_URL_CHARS = 14_000_000;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;

const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

/** Server-internal representation of a non-image file attachment (ID-only, no bytes). */
export const ChatFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
  /** Original file path on the user's filesystem. Present for desktop (path transport) and
   * set to the attachmentsDir copy for web (base64 transport). Providers should use this
   * to reference the file in prompt context rather than the internal attachmentsDir copy. */
  sourcePath: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))),
  entryKind: Schema.optional(Schema.Literals(["file", "directory"])).pipe(
    Schema.withDecodingDefault(() => "file" as const),
  ),
});
export type ChatFileAttachment = typeof ChatFileAttachment.Type;

export const ChatPathReferenceAttachment = Schema.Struct({
  type: Schema.Literal("path"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: Schema.Literal(0),
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  entryKind: Schema.Literals(["file", "directory"]),
});
export type ChatPathReferenceAttachment = typeof ChatPathReferenceAttachment.Type;

export const ChatThreadReferenceAttachment = Schema.Struct({
  type: Schema.Literal("thread"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)).pipe(
    Schema.withDecodingDefault(() => "Thread reference"),
  ),
  mimeType: Schema.Literal("application/x-bigbud-thread-reference").pipe(
    Schema.withDecodingDefault(() => "application/x-bigbud-thread-reference"),
  ),
  sizeBytes: Schema.Literal(0).pipe(Schema.withDecodingDefault(() => 0 as const)),
  threadId: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  watchForCompletion: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
});
export type ChatThreadReferenceAttachment = typeof ChatThreadReferenceAttachment.Type;

const UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  ),
});
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

/** Desktop path-based file upload — server reads bytes from the local filesystem. */
const UploadChatFileAttachmentPath = Schema.Struct({
  type: Schema.Literal("file"),
  transport: Schema.Literal("path"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
  filePath: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});

/** Web base64 fallback — same decode-and-write flow as images. */
const UploadChatFileAttachmentBase64 = Schema.Struct({
  type: Schema.Literal("file"),
  transport: Schema.Literal("base64"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_FILE_DATA_URL_CHARS),
  ),
});

export const UploadChatFileAttachment = Schema.Union([
  UploadChatFileAttachmentPath,
  UploadChatFileAttachmentBase64,
]);
export type UploadChatFileAttachment = typeof UploadChatFileAttachment.Type;

export const UploadChatPathReferenceAttachment = Schema.Struct({
  type: Schema.Literal("path"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: Schema.Literal(0),
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  entryKind: Schema.Literals(["file", "directory"]),
});
export type UploadChatPathReferenceAttachment = typeof UploadChatPathReferenceAttachment.Type;

export const UploadChatThreadReferenceAttachment = Schema.Struct({
  type: Schema.Literal("thread"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: Schema.Literal("application/x-bigbud-thread-reference"),
  sizeBytes: Schema.Literal(0),
  threadId: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  watchForCompletion: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
});
export type UploadChatThreadReferenceAttachment = typeof UploadChatThreadReferenceAttachment.Type;

export const ChatAttachment = Schema.Union([
  ChatImageAttachment,
  ChatFileAttachment,
  ChatPathReferenceAttachment,
  ChatThreadReferenceAttachment,
]);
export type ChatAttachment = typeof ChatAttachment.Type;
export const UploadChatAttachment = Schema.Union([
  UploadChatImageAttachment,
  UploadChatFileAttachment,
  UploadChatPathReferenceAttachment,
  UploadChatThreadReferenceAttachment,
]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;
