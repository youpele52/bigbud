import { createHash } from "node:crypto";

import type { ClientOrchestrationCommand, UploadChatAttachment } from "@bigbud/contracts";

import {
  createAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachments/attachmentStore.ts";
import { parseBase64DataUrl } from "../attachments/imageMime.ts";

type AttachmentCommand = Extract<
  ClientOrchestrationCommand,
  {
    type: "thread.message.submit" | "thread.turn.start" | "thread.shell.run";
  }
>;

export function createNormalizedAttachmentId(
  command: AttachmentCommand,
  index: number,
  attachment: UploadChatAttachment,
  bytes?: Uint8Array,
): string | null {
  // Existing direct-start/shell receipts keep their historical normalization.
  if (command.type !== "thread.message.submit") return createAttachmentId(command.threadId);
  const segment = toSafeThreadAttachmentSegment(command.threadId);
  if (!segment) return null;
  const identity = [
    "message-submit-attachment/v1",
    command.threadId,
    command.commandId,
    command.message.messageId,
    index,
    attachment.type,
    attachment.name,
    attachment.mimeType,
    attachment.sizeBytes,
    attachment.type === "file" ? attachment.transport : null,
    attachment.type === "file" && attachment.transport === "path" ? attachment.filePath : null,
    attachment.type === "path" ? [attachment.path, attachment.entryKind] : null,
    attachment.type === "thread"
      ? [attachment.threadId, attachment.title, attachment.watchForCompletion ?? false]
      : null,
    "dataUrl" in attachment ? parseBase64DataUrl(attachment.dataUrl)?.mimeType : null,
    bytes ? createHash("sha256").update(bytes).digest("hex") : null,
  ];
  const hash = createHash("sha256").update(JSON.stringify(identity)).digest();
  // UUID v8 shape retains the existing attachment ownership/cleanup parser.
  hash[6] = (hash[6]! & 0x0f) | 0x80;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const id = hash.subarray(0, 16).toString("hex");
  return `${segment}-${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
