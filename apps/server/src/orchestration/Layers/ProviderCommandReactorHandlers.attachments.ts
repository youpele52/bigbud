import type { OrchestrationMessage } from "@bigbud/contracts";

/**
 * Appends an `<attached_files>` XML block to provider input so the agent can
 * immediately see attached files (including path-reference attachments from
 * the in-app file browser) without relying on local source paths.
 */
export function appendFileAttachmentsToProviderInput(
  text: string,
  attachments: NonNullable<OrchestrationMessage["attachments"]>,
): string {
  const fileAttachments = attachments.filter(
    (attachment) => attachment.type === "file" || attachment.type === "path",
  );
  if (fileAttachments.length === 0) return text;

  const lines = fileAttachments.map((attachment) => {
    if (attachment.type === "path") {
      const kindLabel = attachment.entryKind === "directory" ? "directory" : "file";
      return `- ${attachment.name} (${kindLabel}, path reference) -> ${attachment.path}`;
    }
    const head = `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`;
    return attachment.sourcePath ? `${head} -> ${attachment.sourcePath}` : head;
  });
  const block = `<attached_files>\n${lines.join("\n")}\n</attached_files>`;
  return text.length > 0 ? `${text}\n\n${block}` : block;
}
