import type { ThreadTitleGenerationInput } from "../Services/TextGeneration.ts";
import { limitSection } from "../Utils.ts";

export function buildCopilotThreadTitlePrompt(input: {
  readonly message: string;
  readonly attachments?: ThreadTitleGenerationInput["attachments"];
}): string {
  const attachmentLines = (input.attachments ?? [])
    .filter((attachment) => attachment.type !== "thread")
    .map(
      (attachment) =>
        `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
    );
  const sections = [
    "Write a concise thread title for a coding conversation.",
    "Return plain text only.",
    "Do not return JSON.",
    "Do not wrap the title in quotes.",
    "Do not include prefixes or trailing punctuation.",
    "Keep it short and specific (3-8 words).",
    "",
    "User message:",
    limitSection(input.message, 8_000),
  ];
  if (attachmentLines.length > 0)
    sections.push("", "Attachment metadata:", limitSection(attachmentLines.join("\n"), 4_000));
  return sections.join("\n");
}
