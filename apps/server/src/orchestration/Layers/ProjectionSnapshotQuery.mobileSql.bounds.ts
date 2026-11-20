import { NonNegativeInt } from "@bigbud/contracts/core/baseSchemas.ts";
import {
  THREAD_DETAIL_TEXT_PREVIEW_LENGTH,
  THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD,
} from "@bigbud/contracts/orchestration/orchestration.detail.ts";
import { Schema, Struct } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ProjectionThreadActivityDbRowSchema,
  ProjectionThreadMessageDbRowSchema,
  ProjectionThreadProposedPlanDbRowSchema,
} from "./ProjectionSnapshotQuerySql.schemas.ts";

/**
 * Per-record bounds for the mobile baseline. They follow the desktop detail helpers in
 * `ProjectionCatalogQuery.boundedText.ts` (same threshold, preview length and `{}` payload) but
 * each exempts the rows the phone cannot render from a preview:
 *
 * - a streaming message, because live deltas append to it and would land after the notice;
 * - an approval or user-input activity (and its respond-failed resolution), because the phone
 *   derives pending requests from those payloads.
 *
 * The length column is set only when the row was cut, so SQL is the single source of truth for
 * which records assembly marks as truncated. Canonical rows are never changed.
 */

const MOBILE_ESSENTIAL_ACTIVITY_KIND_SQL = `(
  (activities.kind COLLATE BINARY >= 'approval.' AND activities.kind COLLATE BINARY < 'approval/')
  OR (activities.kind COLLATE BINARY >= 'user-input.'
    AND activities.kind COLLATE BINARY < 'user-input/')
  OR activities.kind IN ('provider.approval.respond.failed', 'provider.user-input.respond.failed')
)`;

/** Message text for aliased `messages` rows; oversized non-streaming text leaves as a preview. */
export function mobileMessageTextColumnsSql(sql: SqlClient.SqlClient) {
  const oversized = `messages.is_streaming = 0
    AND length(messages.text) > ${THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD}`;
  return sql.unsafe(`
    CASE WHEN ${oversized}
      THEN substr(messages.text, 1, ${THREAD_DETAIL_TEXT_PREVIEW_LENGTH})
      ELSE messages.text
    END AS text,
    CASE WHEN ${oversized} THEN length(messages.text) END AS "textLength"
  `);
}

/** Activity payload for aliased `activities` rows; oversized non-essential payloads become `{}`. */
export function mobileActivityPayloadColumnsSql(sql: SqlClient.SqlClient) {
  const oversized = `NOT ${MOBILE_ESSENTIAL_ACTIVITY_KIND_SQL}
    AND length(activities.payload_json) > ${THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD}`;
  return sql.unsafe(`
    CASE WHEN ${oversized} THEN '{}' ELSE activities.payload_json END AS payload,
    CASE WHEN ${oversized} THEN length(activities.payload_json) END AS "payloadLength"
  `);
}

/** Proposed plan markdown; oversized markdown leaves as a preview. */
export function mobilePlanMarkdownColumnsSql(sql: SqlClient.SqlClient) {
  const oversized = `length(plan_markdown) > ${THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD}`;
  return sql.unsafe(`
    CASE WHEN ${oversized}
      THEN substr(plan_markdown, 1, ${THREAD_DETAIL_TEXT_PREVIEW_LENGTH})
      ELSE plan_markdown
    END AS "planMarkdown",
    CASE WHEN ${oversized} THEN length(plan_markdown) END AS "planMarkdownLength"
  `);
}

/**
 * Checkpoint files: an oversized list keeps its leading files whose JSON fits under the
 * threshold, rebuilt in SQLite so the full list never reaches JavaScript or the schema decoder.
 */
export function mobileCheckpointFilesColumnSql(sql: SqlClient.SqlClient) {
  return sql.unsafe(`
    CASE WHEN length(checkpoint_files_json) > ${THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD}
      THEN (
        SELECT COALESCE(json_group_array(json(kept.value)), '[]')
        FROM (
          SELECT entries.value,
            SUM(length(entries.value) + 1) OVER (ORDER BY entries.key) AS running_length
          FROM json_each(checkpoint_files_json) AS entries
          ORDER BY entries.key
        ) AS kept
        WHERE kept.running_length < ${THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD}
      )
      ELSE checkpoint_files_json
    END AS "files"
  `);
}

export const MobileThreadMessageDbRowSchema = ProjectionThreadMessageDbRowSchema.mapFields(
  Struct.assign({ textLength: Schema.NullOr(NonNegativeInt) }),
);
export type MobileThreadMessageDbRow = typeof MobileThreadMessageDbRowSchema.Type;

export const MobileThreadActivityDbRowSchema = ProjectionThreadActivityDbRowSchema.mapFields(
  Struct.assign({ payloadLength: Schema.NullOr(NonNegativeInt) }),
);
export type MobileThreadActivityDbRow = typeof MobileThreadActivityDbRowSchema.Type;

export const MobileProposedPlanDbRowSchema = ProjectionThreadProposedPlanDbRowSchema.mapFields(
  Struct.assign({ planMarkdownLength: Schema.NullOr(NonNegativeInt) }),
);
export type MobileProposedPlanDbRow = typeof MobileProposedPlanDbRowSchema.Type;
