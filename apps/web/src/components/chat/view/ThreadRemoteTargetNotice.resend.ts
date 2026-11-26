import type { UploadChatAttachment } from "@bigbud/contracts/orchestration/orchestration.attachments.ts";

import { newCommandId, newMessageId } from "../../../lib/utils";
import type { ChatAttachment, Thread } from "../../../models/types/app.types";
import { readNativeApi } from "../../../rpc/nativeApi";
import { resolveFullMessageText } from "../../../stores/main/messageText.store";

/**
 * The upload form of a stored attachment, when it can be sent again without its bytes: path and
 * thread references as is, files by their source path. `null` for images (their bytes are not
 * kept in the client), so the message must be sent again from the composer.
 */
export function toResendAttachment(attachment: ChatAttachment): UploadChatAttachment | null {
  switch (attachment.type) {
    case "path":
      return {
        type: "path",
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: 0,
        path: attachment.path,
        entryKind: attachment.entryKind,
      };
    case "thread":
      return {
        type: "thread",
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: 0,
        threadId: attachment.threadId,
        title: attachment.title,
        watchForCompletion: attachment.watchForCompletion ?? false,
      };
    case "file":
      return attachment.sourcePath
        ? {
            type: "file",
            transport: "path",
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            filePath: attachment.sourcePath,
          }
        : null;
    case "image":
      return null;
  }
}

/** All attachments in upload form, or `null` when any cannot be resent automatically. */
export function toResendAttachments(
  attachments: readonly ChatAttachment[] | undefined,
): UploadChatAttachment[] | null {
  const mapped = (attachments ?? []).map(toResendAttachment);
  return mapped.every((entry) => entry !== null) ? mapped : null;
}

export function canResendMessage(
  thread: Pick<Thread, "messages">,
  messageId: string | undefined,
): boolean {
  const message = thread.messages.find((entry) => entry.id === messageId && entry.role === "user");
  return message !== undefined && toResendAttachments(message.attachments) !== null;
}

/**
 * Sends the unsent message again as a new turn in the same thread (explicit user action only:
 * the failure was proven to precede dispatch, but a turn is never resent automatically).
 */
export async function resendUnsentMessage(
  thread: Pick<Thread, "id" | "messages" | "runtimeMode" | "interactionMode">,
  messageId: string,
): Promise<boolean> {
  const api = readNativeApi();
  const message = thread.messages.find((entry) => entry.id === messageId && entry.role === "user");
  const attachments = toResendAttachments(message?.attachments);
  if (!api || !message || !attachments) return false;
  const text = await resolveFullMessageText(thread.id, message, api);
  await api.orchestration.dispatchCommand({
    type: "thread.turn.start",
    commandId: newCommandId(),
    threadId: thread.id,
    message: {
      messageId: newMessageId(),
      role: "user",
      text,
      attachments,
    },
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    createdAt: new Date().toISOString(),
  });
  return true;
}
