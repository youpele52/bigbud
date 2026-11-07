import {
  THREAD_DETAIL_MESSAGE_ATTACHMENT_MAX_LIMIT,
  THREAD_DETAIL_PAGE_TEXT_BUDGET,
  THREAD_DETAIL_TEXT_PREVIEW_LENGTH,
  THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD,
  type ThreadDetailMessage,
} from "@bigbud/contracts/orchestration/orchestration.detail.ts";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ThreadDetailMessageDbRow } from "./ProjectionCatalogQuery.schemas.ts";

/**
 * Message text for a bounded page: text over the threshold leaves SQLite as its first
 * `THREAD_DETAIL_TEXT_PREVIEW_LENGTH` characters, with the full length alongside, so an oversized
 * row never reaches JavaScript whole.
 */
export function boundedMessageTextColumnsSql(sql: SqlClient.SqlClient, column = "text") {
  return sql.unsafe(`
    CASE WHEN length(${column}) > ${THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD}
      THEN substr(${column}, 1, ${THREAD_DETAIL_TEXT_PREVIEW_LENGTH})
      ELSE ${column}
    END AS text,
    length(${column}) AS "textLength"
  `);
}

/** Activity payloads over the threshold are replaced by `{}` and flagged with their length. */
export function boundedActivityPayloadColumnsSql(
  sql: SqlClient.SqlClient,
  column = "payload_json",
) {
  return sql.unsafe(`
    CASE WHEN length(${column}) > ${THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD}
      THEN '{}'
      ELSE ${column}
    END AS payload,
    length(${column}) AS "payloadLength"
  `);
}

export function activityTruncationFields(payloadLength: number | null | undefined) {
  return payloadLength !== null &&
    payloadLength !== undefined &&
    payloadLength > THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD
    ? { payloadTruncated: true, payloadLength }
    : {};
}

export function normalizeDetailMessage(row: ThreadDetailMessageDbRow): ThreadDetailMessage {
  const attachments = row.attachments ?? [];
  const textTruncated =
    row.textLength !== undefined && row.textLength > THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD;
  return {
    id: row.messageId,
    role: row.role,
    text: row.text,
    attachments: attachments.slice(0, THREAD_DETAIL_MESSAGE_ATTACHMENT_MAX_LIMIT),
    attachmentsTruncated: attachments.length > THREAD_DETAIL_MESSAGE_ATTACHMENT_MAX_LIMIT,
    ...(row.replyTo !== null ? { replyTo: row.replyTo } : {}),
    ...(row.originSegments !== null ? { originSegments: row.originSegments } : {}),
    turnId: row.turnId,
    streaming: row.isStreaming === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(textTruncated ? { textTruncated: true, textLength: row.textLength } : {}),
  };
}

/**
 * Keeps newest-first rows within `limit` and the page text budget. The first row is always kept,
 * so a page never comes back empty; the cursor then points at the oldest kept row.
 */
export function applyMessagePageTextBudget<T extends { readonly text: string }>(
  rows: ReadonlyArray<T>,
  limit: number,
  budget = THREAD_DETAIL_PAGE_TEXT_BUDGET,
): { readonly rows: ReadonlyArray<T>; readonly hasOlder: boolean } {
  const kept: T[] = [];
  let total = 0;
  for (const row of rows.slice(0, limit)) {
    if (kept.length > 0 && total + row.text.length > budget) {
      return { rows: kept, hasOlder: true };
    }
    kept.push(row);
    total += row.text.length;
  }
  return { rows: kept, hasOlder: rows.length > limit };
}
