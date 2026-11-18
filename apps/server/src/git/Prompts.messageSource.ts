import type { ChatAttachment } from "@bigbud/contracts/orchestration/orchestration.attachments.ts";

import { limitSection } from "./Utils.ts";

const MESSAGE_MAX_CHARS = 8_000;
const ATTACHMENT_METADATA_MAX_CHARS = 4_000;

/** Shared source budgets for auxiliary prompts and isolated native metadata requests. */
export function prepareMessageSource(input: {
  readonly message: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
}): { readonly message: string; readonly attachmentMetadata: string } {
  // Collect only one character beyond the budget to retain limitSection's truncation semantics.
  // Do not map/join unbounded attachment names or allocate an entire metadata section first.
  let metadata = "";
  for (const attachment of input.attachments ?? []) {
    if (attachment.type === "thread") continue;
    const parts = [
      metadata ? "\n- " : "- ",
      attachment.name,
      " (",
      attachment.mimeType,
      `, ${attachment.sizeBytes} bytes)`,
    ];
    for (const part of parts) {
      const remaining = ATTACHMENT_METADATA_MAX_CHARS + 1 - metadata.length;
      if (remaining <= 0) break;
      metadata += part.slice(0, remaining);
    }
    if (metadata.length > ATTACHMENT_METADATA_MAX_CHARS) break;
  }
  return {
    message: limitSection(input.message, MESSAGE_MAX_CHARS),
    attachmentMetadata: limitSection(metadata, ATTACHMENT_METADATA_MAX_CHARS),
  };
}
