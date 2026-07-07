import type { ProviderInteractionMode, RuntimeMode, ThreadId } from "@bigbud/contracts";
import type { SeedMessageOutput } from "./threadBranch";

import { readNativeApi } from "../rpc/nativeApi";
import { selectIsThreadRunning, selectThreadById, useStore } from "../stores/main";
import { buildSkillMentionPrompt } from "./skillMentions";
import { newCommandId, newMessageId } from "./utils";

export const HANDOFF_SKILL_PROMPT = buildSkillMentionPrompt("handoff");
const DEFAULT_HANDOFF_TIMEOUT_MS = 120_000;
const HANDOFF_POLL_INTERVAL_MS = 100;
const HANDOFF_COMPLETION_GRACE_MS = 5_000;
const HANDOFF_DOCUMENT_TAG_REGEX = /<handoff_document>\s*([\s\S]*?)\s*<\/handoff_document>/i;
const MARKDOWN_HEADING_REGEX = /^#{1,6}\s+/m;
const HANDOFF_FALLBACK_MIN_LENGTH = 200;
const HANDOFF_SEED_PATH_MIME_TYPE = "text/markdown";
const HANDOFF_SEED_PATH_ENTRY_KIND = "file";

const HANDOFF_SEED_INSTRUCTION_LINES = [
  "Before answering later requests in this branched thread, read the handoff document at the attached path.",
  "Use that file as the authoritative summary/context for this branch.",
] as const;

export class HandoffError extends Error {
  override readonly name = "HandoffError";
}

interface DispatchHandoffTurnInput {
  threadId: ThreadId;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
}

/**
 * Dispatches a turn in the given thread that invokes the curated handoff skill.
 * Throws if the native API is unavailable or the dispatch fails.
 */
export async function dispatchHandoffSkillTurn(input: DispatchHandoffTurnInput): Promise<string> {
  const api = readNativeApi();
  if (!api) {
    throw new HandoffError("Native API is not available.");
  }

  const messageId = newMessageId();
  await api.orchestration.dispatchCommand({
    type: "thread.turn.start",
    commandId: newCommandId(),
    threadId: input.threadId,
    message: {
      messageId,
      role: "user",
      text: HANDOFF_SKILL_PROMPT,
      attachments: [],
    },
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    createdAt: new Date().toISOString(),
  });
  return messageId;
}

interface WaitForHandoffSummaryOptions {
  requestMessageId?: string;
  timeoutMs?: number;
}

function extractHandoffDocument(text: string): string | null {
  const tagMatch = HANDOFF_DOCUMENT_TAG_REGEX.exec(text);
  const document = tagMatch?.[1]?.trim();
  return document && document.length > 0 ? document : null;
}

/**
 * Fallback extractor for assistant responses that did not wrap the handoff in
 * `<handoff_document>` tags. Accepts plain markdown that looks like a handoff
 * document (has a heading or is reasonably long) so a provider that ignored the
 * XML instruction does not hard-fail the branch flow.
 */
function extractFallbackHandoffDocument(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const looksLikeDocument =
    MARKDOWN_HEADING_REGEX.test(trimmed) || trimmed.length >= HANDOFF_FALLBACK_MIN_LENGTH;
  return looksLikeDocument ? trimmed : null;
}

function fileNameFromPath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? "handoff.md";
}

export function buildHandoffSeedMessage(filePath: string): SeedMessageOutput {
  const createdAt = new Date().toISOString();
  return {
    id: newMessageId(),
    role: "user",
    text: [
      HANDOFF_SEED_INSTRUCTION_LINES[0],
      `Handoff file: ${filePath}`,
      HANDOFF_SEED_INSTRUCTION_LINES[1],
    ].join("\n"),
    attachments: [
      {
        type: "path",
        id: newMessageId(),
        name: fileNameFromPath(filePath),
        mimeType: HANDOFF_SEED_PATH_MIME_TYPE,
        sizeBytes: 0,
        path: filePath,
        entryKind: HANDOFF_SEED_PATH_ENTRY_KIND,
      },
    ],
    turnId: null,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
}

export function isHandoffSeedMessage(message: {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<
    | {
        readonly type: "image";
      }
    | {
        readonly type: "file";
      }
    | {
        readonly type: "path";
        readonly mimeType: string;
        readonly sizeBytes: 0;
        readonly path: string;
        readonly entryKind: "file" | "directory";
      }
    | {
        readonly type: "thread";
      }
  >;
}): boolean {
  if (message.role !== "user") {
    return false;
  }

  if (
    !HANDOFF_SEED_INSTRUCTION_LINES.every((line) => message.text.includes(line)) ||
    !message.text.includes("Handoff file: ")
  ) {
    return false;
  }

  if ((message.attachments?.length ?? 0) !== 1) {
    return false;
  }

  const [attachment] = message.attachments ?? [];
  return (
    attachment?.type === "path" &&
    attachment.mimeType === HANDOFF_SEED_PATH_MIME_TYPE &&
    attachment.sizeBytes === 0 &&
    attachment.entryKind === HANDOFF_SEED_PATH_ENTRY_KIND &&
    attachment.path.length > 0
  );
}

/**
 * Waits for the handoff turn dispatched by {@link dispatchHandoffSkillTurn} to
 * complete and returns the handoff document produced for that turn.
 *
 * The function identifies the handoff attempt by the exact dispatched user
 * message id, then scans assistant responses after it for a machine-readable
 * handoff document block.
 */
export function waitForHandoffDocument(
  threadId: ThreadId,
  options?: WaitForHandoffSummaryOptions,
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS;
  const requestMessageId = options?.requestMessageId ?? null;

  return new Promise((resolve, reject) => {
    let intervalHandle: ReturnType<typeof setInterval> | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let completionDetectedAt: number | null = null;

    const cleanup = (onComplete: () => void) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (intervalHandle) clearInterval(intervalHandle);
      onComplete();
    };

    const check = () => {
      const state = useStore.getState();
      const thread = selectThreadById(threadId)(state);
      if (!thread) {
        cleanup(() =>
          reject(new HandoffError("Source thread disappeared while generating handoff.")),
        );
        return;
      }

      const requestMessageIndex =
        requestMessageId !== null
          ? thread.messages.findIndex((message) => message.id === requestMessageId)
          : thread.messages.findLastIndex(
              (message) => message.role === "user" && message.text.trim() === HANDOFF_SKILL_PROMPT,
            );

      if (requestMessageIndex < 0) {
        return;
      }

      const assistantMessages = thread.messages
        .slice(requestMessageIndex + 1)
        .filter((message) => message.role === "assistant" && !message.streaming && message.text);
      const handoffDocument = assistantMessages
        .map(
          (message) =>
            extractHandoffDocument(message.text) ?? extractFallbackHandoffDocument(message.text),
        )
        .findLast((document) => document !== null);
      if (handoffDocument) {
        cleanup(() => resolve(handoffDocument));
        return;
      }

      if (!selectIsThreadRunning(threadId)(state)) {
        const requestMessage = thread.messages[requestMessageIndex];
        if (requestMessage?.text.trim() !== HANDOFF_SKILL_PROMPT) {
          cleanup(() =>
            reject(new HandoffError("Handoff request was replaced before completion.")),
          );
          return;
        }
        if (assistantMessages.length === 0) {
          return;
        }
        if (completionDetectedAt === null) {
          completionDetectedAt = Date.now();
          return;
        }
        if (Date.now() - completionDetectedAt < HANDOFF_COMPLETION_GRACE_MS) {
          return;
        }
        cleanup(() =>
          reject(
            new HandoffError(
              "Handoff completed without producing a handoff document. The assistant response did not contain a `<handoff_document>` block and did not look like a plain markdown handoff.",
            ),
          ),
        );
        return;
      }

      completionDetectedAt = null;
    };

    intervalHandle = setInterval(check, HANDOFF_POLL_INTERVAL_MS);
    timeoutHandle = setTimeout(() => {
      cleanup(() => reject(new HandoffError("Handoff generation timed out.")));
    }, timeoutMs);
    check();
  });
}

interface GenerateHandoffSummaryInput {
  threadId: ThreadId;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
}

/**
 * Simpler wait that resolves with the text of the first non-streaming assistant
 * message after a handoff skill turn completes. Rejects if the thread
 * disappears or the timeout is reached.
 */
export function waitForHandoffSummary(
  threadId: ThreadId,
  options?: WaitForHandoffSummaryOptions,
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let intervalHandle: ReturnType<typeof setInterval> | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (onComplete: () => void) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (intervalHandle) clearInterval(intervalHandle);
      onComplete();
    };

    const check = () => {
      const state = useStore.getState();
      const thread = selectThreadById(threadId)(state);
      if (!thread) {
        cleanup(() =>
          reject(new HandoffError("Source thread disappeared while generating handoff.")),
        );
        return;
      }

      const assistantMessage = [...thread.messages]
        .toReversed()
        .find((message) => message.role === "assistant" && !message.streaming && message.text);
      if (assistantMessage) {
        cleanup(() => resolve(assistantMessage.text));
        return;
      }
    };

    intervalHandle = setInterval(check, HANDOFF_POLL_INTERVAL_MS);
    timeoutHandle = setTimeout(() => {
      cleanup(() => reject(new HandoffError("Handoff generation timed out.")));
    }, timeoutMs);
    check();
  });
}

/**
 * Convenience helper that runs the handoff skill on the source thread and
 * returns the generated handoff document text.
 */
export async function generateHandoffDocument(
  input: GenerateHandoffSummaryInput,
  options?: WaitForHandoffSummaryOptions,
): Promise<string> {
  const requestMessageId = await dispatchHandoffSkillTurn(input);
  return waitForHandoffDocument(input.threadId, {
    ...options,
    requestMessageId,
  });
}
