import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type {
  InsertRetentionItemsInput,
  InsertRetentionPageInput,
  InsertRetentionPageResult,
  ThreadRetentionCandidate,
  ThreadRetentionRepositoryShape,
} from "../Services/ThreadRetentionRepository.ts";
import { retentionExclusionCaseSql } from "./ThreadRetentionRepository.eligibility.ts";

const OUTSTANDING_STATUSES = ["selected", "deletion_requested", "prepared", "purging"];
const clampLimit = (limit: number) => Math.max(1, Math.min(250, Math.floor(limit)));

export const retentionCandidateSelectSql = `
  SELECT t.thread_id AS "threadId", t.last_activity_at AS "lastActivityAt"
  FROM projection_threads AS t
  WHERE t.deleted_at IS NULL AND t.deleting_at IS NULL AND t.pinned_at IS NULL
    AND t.last_activity_at <= ?
    AND (? IS NULL OR t.last_activity_at > ?
      OR (t.last_activity_at = ? AND t.thread_id > ?))
    AND (${retentionExclusionCaseSql}) IS NULL
  ORDER BY t.last_activity_at ASC, t.thread_id ASC LIMIT ?
`;

export function makeThreadRetentionPages(sql: SqlClient.SqlClient) {
  const selectNextPage = (
    input: Parameters<ThreadRetentionRepositoryShape["selectNextPage"]>[0],
  ) => {
    const cursorAt = input.cursor?.lastActivityAt ?? null;
    const cursorThreadId = input.cursor?.threadId ?? null;
    return sql.unsafe<ThreadRetentionCandidate>(retentionCandidateSelectSql, [
      input.cutoffAt,
      cursorAt,
      cursorAt,
      cursorAt,
      cursorThreadId,
      clampLimit(input.limit),
    ]);
  };

  const insertSelectedPage = Effect.fn("ThreadRetentionRepository.insertSelectedPage")(function* (
    input: Parameters<ThreadRetentionRepositoryShape["insertSelectedPage"]>[0],
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const expectedAt = input.expectedCursor?.lastActivityAt ?? null;
        const expectedThreadId = input.expectedCursor?.threadId ?? null;
        const claimed = yield* sql`
            UPDATE thread_retention_runs
            SET cursor_last_activity_at = ${input.nextCursor.lastActivityAt},
              cursor_thread_id = ${input.nextCursor.threadId}, updated_at = ${input.createdAt}
            WHERE run_id = ${input.runId} AND status = ${input.expectedStatus}
              AND ((${
                input.expectedCursor === null ? 1 : 0
              } = 1 AND cursor_last_activity_at IS NULL AND cursor_thread_id IS NULL)
                OR (cursor_last_activity_at = ${expectedAt} AND cursor_thread_id = ${expectedThreadId}))
            RETURNING run_id
          `;
        if (claimed.length !== 1) {
          const outstanding = yield* sql<{ count: number }>`
              SELECT COUNT(*) AS count FROM thread_retention_run_items
              WHERE run_id = ${input.runId} AND status IN ${sql.in(OUTSTANDING_STATUSES)}
            `;
          return {
            applied: false,
            insertedCount: 0,
            outstandingBacklogCount: outstanding[0]?.count ?? 0,
          };
        }

        let insertedCount = 0;
        for (const candidate of input.candidates) {
          const rows = yield* sql`
              INSERT INTO thread_retention_run_items (
                run_id, thread_id, expected_last_activity_at, deletion_command_id,
                status, created_at, updated_at
              ) VALUES (${input.runId}, ${candidate.threadId}, ${candidate.lastActivityAt},
                ${candidate.deletionCommandId}, 'selected', ${input.createdAt}, ${input.createdAt})
              ON CONFLICT DO NOTHING RETURNING thread_id
            `;
          insertedCount += rows.length;
        }
        yield* sql`
            UPDATE thread_retention_runs
            SET selected_count = selected_count + ${insertedCount}, updated_at = ${input.createdAt}
            WHERE run_id = ${input.runId}
          `;
        const outstanding = yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM thread_retention_run_items
            WHERE run_id = ${input.runId} AND status IN ${sql.in(OUTSTANDING_STATUSES)}
          `;
        return {
          applied: true,
          insertedCount,
          outstandingBacklogCount: outstanding[0]?.count ?? 0,
        };
      }),
    );
  });

  const insertLegacyItems = Effect.fn("ThreadRetentionRepository.insertLegacyItems")(function* (
    input: Exclude<
      Parameters<ThreadRetentionRepositoryShape["insertSelectedItems"]>[0],
      { readonly expectedStatus: "selecting" }
    >,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        let insertedCount = 0;
        for (const candidate of input.candidates) {
          const rows = yield* sql`
            INSERT INTO thread_retention_run_items (
              run_id, thread_id, expected_last_activity_at, deletion_command_id,
              status, created_at, updated_at
            ) VALUES (${input.runId}, ${candidate.threadId}, ${candidate.lastActivityAt},
              ${candidate.deletionCommandId}, 'selected', ${input.createdAt}, ${input.createdAt})
            ON CONFLICT DO NOTHING RETURNING thread_id
          `;
          insertedCount += rows.length;
        }
        yield* sql`
          UPDATE thread_retention_runs SET selected_count = selected_count + ${insertedCount},
            cursor_last_activity_at = CASE WHEN ${input.cursor === undefined ? 0 : 1} = 1
              THEN ${input.cursor?.lastActivityAt ?? null} ELSE cursor_last_activity_at END,
            cursor_thread_id = CASE WHEN ${input.cursor === undefined ? 0 : 1} = 1
              THEN ${input.cursor?.threadId ?? null} ELSE cursor_thread_id END,
            updated_at = ${input.createdAt} WHERE run_id = ${input.runId}
        `;
        return insertedCount;
      }),
    );
  });

  const insertSelectedItems = (input: InsertRetentionItemsInput | InsertRetentionPageInput) => {
    if ("expectedStatus" in input) {
      return insertSelectedPage(input).pipe(
        Effect.map((result): number | InsertRetentionPageResult => result),
      );
    }
    return insertLegacyItems(input).pipe(
      Effect.map((result): number | InsertRetentionPageResult => result),
    );
  };

  const countOutstandingItems = (runId: string) =>
    sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM thread_retention_run_items
      WHERE run_id = ${runId} AND status IN ${sql.in(OUTSTANDING_STATUSES)}
    `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));

  return { selectNextPage, insertSelectedItems, insertSelectedPage, countOutstandingItems };
}
