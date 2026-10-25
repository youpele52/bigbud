/**
 * Attachment files are named after the thread that uploaded them, but a server-side fork keeps
 * the same attachment ids (plan D17). Before a thread prunes its files, keep every file another
 * thread's messages or queued prompts still reference.
 *
 * @module ProjectionPipeline.attachments.shared
 */
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  attachmentRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../attachments/attachmentStore.ts";
import type { AttachmentSideEffects } from "./ProjectionPipeline.helpers.ts";

type StoredAttachment = Parameters<typeof attachmentRelativePath>[0];

function attachmentsIn(json: string): ReadonlyArray<StoredAttachment> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    // Message rows store attachments directly; queued prompts nest them per prompt.
    return parsed.flatMap((entry) =>
      Array.isArray((entry as { attachments?: unknown })?.attachments)
        ? ((entry as { attachments: StoredAttachment[] }).attachments ?? [])
        : [entry as StoredAttachment],
    );
  } catch {
    return [];
  }
}

export const keepAttachmentsSharedWithOtherThreads = Effect.fn(
  "keepAttachmentsSharedWithOtherThreads",
)(function* (sql: SqlClient.SqlClient, sideEffects: AttachmentSideEffects) {
  for (const [threadId, kept] of sideEffects.prunedThreadRelativePaths) {
    const segment = toSafeThreadAttachmentSegment(threadId);
    if (!segment) continue;
    const pattern = `%${segment}-%`;
    const rows = yield* sql<{ readonly json: string }>`
      SELECT attachments_json AS json FROM projection_thread_messages
      WHERE thread_id <> ${threadId} AND attachments_json LIKE ${pattern}
      UNION ALL
      SELECT queued_prompts_json AS json FROM projection_threads
      WHERE thread_id <> ${threadId} AND queued_prompts_json LIKE ${pattern}
    `;
    for (const row of rows) {
      for (const attachment of attachmentsIn(row.json)) {
        if (typeof attachment?.id !== "string") continue;
        if (parseThreadSegmentFromAttachmentId(attachment.id) !== segment) continue;
        const relativePath = attachmentRelativePath(attachment);
        if (relativePath) kept.add(relativePath);
      }
    }
  }
});
