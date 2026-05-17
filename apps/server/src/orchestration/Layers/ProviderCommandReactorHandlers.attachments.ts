import type { OrchestrationMessage } from "@bigbud/contracts";

/**
 * Appends an `<attached_files>` XML block to provider input so the agent can
 * immediately see attached files without relying on local source paths.
 */
export function appendFileAttachmentsToProviderInput(
  text: string,
  attachments: NonNullable<OrchestrationMessage["attachments"]>,
): string {
  const fileAttachments = attachments.filter((attachment) => attachment.type === "file");
  if (fileAttachments.length === 0) return text;

  const lines = fileAttachments.map(
    (attachment) => `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
  );
  const block = `<attached_files>\n${lines.join("\n")}\n</attached_files>`;
  return text.length > 0 ? `${text}\n\n${block}` : block;
}
