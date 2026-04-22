import type {
  ChatAttachment,
  OrchestrationMessage,
  OrchestrationMessageRole,
} from "@bigbud/contracts";

export interface BootstrapInputResult {
  text: string;
  includedCount: number;
  omittedCount: number;
  truncated: boolean;
}

const BOOTSTRAP_PREAMBLE =
  "Continue this conversation using the transcript context below. The final section is the latest user request to answer now.";
const TRANSCRIPT_HEADER = "Transcript context:";
const LATEST_PROMPT_HEADER = "Latest user request (answer this now):";
const OMITTED_SUMMARY = (count: number) =>
  `[${count} earlier message(s) omitted to stay within input limits.]`;

type BootstrapMessage = Pick<OrchestrationMessage, "role" | "text" | "attachments">;

function messageRoleLabel(message: BootstrapMessage): "USER" | "ASSISTANT" | "SYSTEM" {
  switch (message.role satisfies OrchestrationMessageRole) {
    case "assistant":
      return "ASSISTANT";
    case "system":
      return "SYSTEM";
    case "user":
    default:
      return "USER";
  }
}

function attachmentSummary(message: BootstrapMessage): string | null {
  const imageAttachments = message.attachments?.filter((attachment) => attachment.type === "image");
  const count = imageAttachments?.length ?? 0;
  if (count === 0) {
    return null;
  }

  const names = imageAttachments?.slice(0, 3).map((image) => image.name) ?? [];
  const namesSummary = names.join(", ");
  const extraCount = count - names.length;
  const extraSummary = extraCount > 0 ? ` (+${extraCount} more)` : "";
  return `[Attached image${count === 1 ? "" : "s"}: ${namesSummary}${extraSummary}]`;
}

function buildMessageBlock(message: BootstrapMessage): string {
  const text = message.text;
  const attachments = attachmentSummary(message);

  if (text && attachments) {
    return `${messageRoleLabel(message)}:\n${text}\n${attachments}`;
  }
  if (text) {
    return `${messageRoleLabel(message)}:\n${text}`;
  }
  if (attachments) {
    return `${messageRoleLabel(message)}:\n${attachments}`;
  }
  return `${messageRoleLabel(message)}:\n(empty message)`;
}

function finalizeWithPrompt(
  transcriptBody: string,
  latestPrompt: string,
  maxChars: number,
): string | null {
  const text = `${BOOTSTRAP_PREAMBLE}\n\n${TRANSCRIPT_HEADER}\n${transcriptBody}\n\n${LATEST_PROMPT_HEADER}\n${latestPrompt}`;
  return text.length <= maxChars ? text : null;
}

export function hasImageAttachments(
  attachments: ReadonlyArray<ChatAttachment> | undefined,
): boolean {
  return attachments?.some((attachment) => attachment.type === "image") ?? false;
}

/** Returns true when there are any non-image file attachments. */
export function hasFileAttachments(
  attachments: ReadonlyArray<ChatAttachment> | undefined,
): boolean {
  return attachments?.some((attachment) => attachment.type === "file") ?? false;
}

/** Returns true when there are any attachments (images or files). */
export function hasAnyAttachments(attachments: ReadonlyArray<ChatAttachment> | undefined): boolean {
  return (attachments?.length ?? 0) > 0;
}

export function buildBootstrapInput(
  previousMessages: ReadonlyArray<BootstrapMessage>,
  latestPrompt: string,
  maxChars: number,
): BootstrapInputResult {
  const budget = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : 1;
  const promptOnly = latestPrompt.length <= budget ? latestPrompt : latestPrompt.slice(0, budget);

  if (previousMessages.length === 0) {
    return {
      text: promptOnly,
      includedCount: 0,
      omittedCount: 0,
      truncated: promptOnly.length !== latestPrompt.length,
    };
  }

  const newestFirstBlocks: string[] = [];
  for (let index = previousMessages.length - 1; index >= 0; index -= 1) {
    const message = previousMessages[index];
    if (!message) continue;
    newestFirstBlocks.push(buildMessageBlock(message));
  }

  if (newestFirstBlocks.length === 0) {
    return {
      text: promptOnly,
      includedCount: 0,
      omittedCount: previousMessages.length,
      truncated: true,
    };
  }

  let includedNewestFirst: string[] = [];
  for (const block of newestFirstBlocks) {
    const nextNewestFirst = [...includedNewestFirst, block];
    const nextChronological = nextNewestFirst.toReversed();
    const omittedCount = newestFirstBlocks.length - nextChronological.length;
    const transcriptBody =
      omittedCount > 0
        ? `${OMITTED_SUMMARY(omittedCount)}\n\n${nextChronological.join("\n\n")}`
        : nextChronological.join("\n\n");
    if (!finalizeWithPrompt(transcriptBody, latestPrompt, budget)) {
      break;
    }
    includedNewestFirst = nextNewestFirst;
  }

  let includedChronological = includedNewestFirst.toReversed();
  while (true) {
    const omittedCount = newestFirstBlocks.length - includedChronological.length;
    const transcriptBody =
      omittedCount > 0
        ? includedChronological.length > 0
          ? `${OMITTED_SUMMARY(omittedCount)}\n\n${includedChronological.join("\n\n")}`
          : OMITTED_SUMMARY(omittedCount)
        : includedChronological.join("\n\n");
    const finalized = finalizeWithPrompt(transcriptBody, latestPrompt, budget);
    if (finalized) {
      return {
        text: finalized,
        includedCount: includedChronological.length,
        omittedCount,
        truncated: omittedCount > 0 || latestPrompt.length !== promptOnly.length,
      };
    }

    if (includedChronological.length === 0) {
      return {
        text: promptOnly,
        includedCount: 0,
        omittedCount: previousMessages.length,
        truncated: true,
      };
    }

    includedChronological = includedChronological.slice(1);
  }
}
