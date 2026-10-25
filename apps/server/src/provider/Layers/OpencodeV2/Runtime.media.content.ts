import { pathToFileURL } from "node:url";
import type { SessionPromptInput } from "@opencode/client";
import {
  attachmentDigest,
  prepareAttachmentContext,
  type PreparedAttachment,
} from "../../../attachments/providerAttachments.ts";
import { assertV2MediaFormat } from "./Media.formats.ts";
import { V2_MEDIA_TOTAL_BYTES } from "./Media.limits.ts";

export interface V2MediaOptions {
  readonly nativeImages?: boolean;
  readonly tools?: boolean;
  readonly pathReachable?: boolean;
}

/** V2's binary contract is images only; documents use the shared extraction layer. */
export async function prepareV2AttachmentContent(
  prompt: string,
  attachments: readonly PreparedAttachment[],
  references: readonly object[] = [],
  options: V2MediaOptions = {},
) {
  const total = attachments.reduce((sum, attachment) => sum + attachment.bytes.length, 0);
  if (total > V2_MEDIA_TOTAL_BYTES) throw new Error("V2 attachment total byte bound exceeded.");
  const context = await prepareAttachmentContext(prompt, attachments);
  const files: NonNullable<SessionPromptInput["files"]>[number][] = [];
  for (const { attachment, bytes, path } of attachments) {
    const image = attachment.mimeType.startsWith("image/");
    const unavailable = context.unextractableIds.includes(attachment.id);
    if (image && options.nativeImages !== false) {
      assertV2MediaFormat(bytes, attachment.mimeType);
      files.push({
        uri: path
          ? pathToFileURL(path).href
          : `data:${attachment.mimeType};base64,${bytes.toString("base64")}`,
        name: attachment.name,
      });
    } else if (unavailable && (image || !(options.tools && path))) {
      throw new Error(
        `V2 attachment '${attachment.name}' cannot be delivered to this model/target. Text extraction or OCR is unavailable; attach a text-readable version or select an image-capable model.`,
      );
    }
  }
  const metadata = references.length ? JSON.stringify(references) : undefined;
  return {
    files,
    text:
      options.nativeImages === false &&
      attachments.some(({ attachment }) => attachment.mimeType.startsWith("image/"))
        ? `${context.text}\n\n<visionless_attachment_context>Native image media was not sent because the selected model does not advertise image input. Use only supplemental OCR text, which does not preserve visual layout/details; request an image-capable model for visual analysis. Do not read image bytes with tools as a substitute for vision.</visionless_attachment_context>`
        : context.text,
    warnings: context.warnings,
    references: metadata,
    digest:
      attachments.length || references.length
        ? attachmentDigest([context.digest, files, references])
        : attachmentDigest([]),
  };
}
