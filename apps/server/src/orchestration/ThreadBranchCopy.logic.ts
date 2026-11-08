/**
 * Pure rules for server-side branch copies: batch bounds, the copied ids, and how a projected
 * source message becomes a branch message. No I/O.
 *
 * @module ThreadBranchCopy.logic
 */
import { createHash } from "node:crypto";

import { CommandId, MessageId, type OrchestrationMessage, type ThreadId } from "@bigbud/contracts";

import type { ProjectionThreadMessage } from "../persistence/Services/ProjectionThreadMessages.ts";

/**
 * One batch is one `thread.branch-copy.append` command and so one engine transaction. The
 * `thread.create` seed cap (200 messages) bounded write amplification per command; a copy
 * batch keeps far under it, by count and by text, so each transaction stays inside the
 * ~50 ms budget. A single message larger than the text bound still goes alone.
 */
export const BRANCH_COPY_BATCH = {
  maxMessages: 25,
  maxTextChars: 256 * 1024,
} as const;

/** Suffix that marks a branch whose copy did not finish; visible wherever the title is. */
export const BRANCH_COPY_FAILED_TITLE_SUFFIX = " (incomplete copy)";

/**
 * Copied ids share one prefix per branch and end in the source id, so among messages with the
 * same `created_at` the branch sorts exactly like the source (ties order by message id).
 * Deterministic, so a replayed batch upserts the same rows instead of adding new ones.
 */
export function branchCopyMessageId(branchThreadId: ThreadId, sourceMessageId: string): MessageId {
  const prefix = createHash("sha256").update(branchThreadId).digest("hex").slice(0, 16);
  return MessageId.makeUnsafe(`message-branch-${prefix}-${sourceMessageId}`);
}

/** Deterministic per batch: a retried batch hits the engine's command receipt. */
export function branchCopyCommandId(
  branchThreadId: ThreadId,
  step: "create" | "fail" | number,
): CommandId {
  return CommandId.makeUnsafe(`branch-copy:${branchThreadId}:${step}`);
}

/** How many of the next rows form one batch: always at least one, then within both bounds. */
export function branchCopyBatchSize(textLengths: ReadonlyArray<number>): number {
  let chars = 0;
  let count = 0;
  for (const length of textLengths) {
    if (count >= BRANCH_COPY_BATCH.maxMessages) break;
    if (count > 0 && chars + length > BRANCH_COPY_BATCH.maxTextChars) break;
    chars += length;
    count += 1;
  }
  return count;
}

/**
 * The branch's copy of a settled source message: full text, the same attachments (the branch's
 * own projection rows then reference the files, so deletion keeps them while the branch lives),
 * replies pointing at the copied message, and no source turn (it does not exist in the branch).
 */
export function toBranchMessage(
  branchThreadId: ThreadId,
  row: ProjectionThreadMessage,
): OrchestrationMessage {
  return {
    id: branchCopyMessageId(branchThreadId, row.messageId),
    role: row.role,
    text: row.text,
    ...(row.attachments && row.attachments.length > 0 ? { attachments: row.attachments } : {}),
    ...(row.replyTo
      ? {
          replyTo: {
            ...row.replyTo,
            messageId: branchCopyMessageId(branchThreadId, row.replyTo.messageId),
          },
        }
      : {}),
    ...(row.originSegments && row.originSegments.length > 0
      ? { originSegments: row.originSegments }
      : {}),
    turnId: null,
    streaming: false,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function failedBranchTitle(title: string): string {
  return title.endsWith(BRANCH_COPY_FAILED_TITLE_SUFFIX)
    ? title
    : `${title}${BRANCH_COPY_FAILED_TITLE_SUFFIX}`;
}
