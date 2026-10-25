import { createHash } from "node:crypto";
import type { ChatAttachment } from "@bigbud/contracts/orchestration/orchestration.attachments.ts";
import {
  appendAttachedFileContents,
  appendAttachedImageOcrContents,
  extractPromptTextFromBuffer,
} from "./documentText.ts";
import { truncateExtractedText } from "./documentText.shared.ts";

export interface PreparedAttachment {
  readonly attachment: ChatAttachment;
  readonly bytes: Buffer;
  /** Only a verified runtime-reachable path, never a desktop sourcePath guess. */
  readonly path?: string;
}

export interface PreparedAttachmentContext {
  readonly text: string;
  readonly digest: string;
  readonly warnings: readonly string[];
  readonly unextractableIds: readonly string[];
}

/** Shared path-first instructions plus bounded supplemental extraction, once per preparation. */
export async function prepareAttachmentContext(
  prompt: string,
  attachments: readonly PreparedAttachment[],
  extract = extractPromptTextFromBuffer,
): Promise<PreparedAttachmentContext> {
  if (!attachments.length)
    return { text: prompt, digest: attachmentDigest([]), warnings: [], unextractableIds: [] };
  const files: { fileName: string; text: string }[] = [];
  const images: { fileName: string; text: string }[] = [];
  const warnings: string[] = [];
  const unextractableIds: string[] = [];
  const references: object[] = [];
  let remaining = 60000;
  for (const { attachment, bytes, path } of attachments) {
    references.push({
      name: attachment.name,
      ...(path ? { path } : { delivery: "supported content fallback; host path unavailable" }),
      sha256: attachmentDigest(bytes),
    });
    let text: string | null;
    try {
      text = await extract({ bytes, mimeType: attachment.mimeType, fileName: attachment.name });
    } catch {
      text = null;
    }
    if (!text) {
      unextractableIds.push(attachment.id);
      warnings.push(
        `${attachment.name}: no supplemental text could be extracted. OCR/PDF helpers may be unavailable or the format may be unsupported. Use the delivered path/native media where supported, or ask for a text-readable version; OCR is not equivalent to the original visual content.`,
      );
      continue;
    }
    const bounded = truncateExtractedText(text);
    const value =
      bounded.length <= remaining
        ? bounded
        : `${bounded.slice(0, Math.max(0, remaining))}\n[Supplemental attachment context truncated]`;
    remaining = Math.max(0, remaining - value.length);
    if (bounded !== text || bounded.includes("[Document text truncated]") || value !== bounded)
      warnings.push(`${attachment.name}: supplemental extracted context was truncated.`);
    (attachment.type === "image" || attachment.mimeType.startsWith("image/") ? images : files).push(
      { fileName: attachment.name, text: value },
    );
  }
  const instructions =
    "<attachment_delivery>\n" +
    "Attached paths refer to immutable snapshots on the provider execution target, not permission to read arbitrary host files. Prefer these paths with available reading tools, subject to existing approvals. Supplemental extracted/OCR text below is approximate and may be incomplete. Never bypass a denied read or silently assume missing visual information.\n" +
    JSON.stringify(references) +
    "\n</attachment_delivery>";
  let text = appendAttachedImageOcrContents(
    appendAttachedFileContents(prompt ? `${prompt}\n\n${instructions}` : instructions, files),
    images,
  );
  if (warnings.length)
    text += `\n\n<attachment_context_notices>\n${warnings.join("\n")}\n</attachment_context_notices>`;
  return {
    text,
    warnings,
    unextractableIds,
    digest: attachmentDigest([references, files, images, warnings]),
  };
}

/** Stable content identity also captures extracted context and target locators. */
export function attachmentDigest(value: unknown): string {
  return createHash("sha256")
    .update(Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest("hex");
}
