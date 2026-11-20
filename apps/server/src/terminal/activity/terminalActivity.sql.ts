import type { TerminalFinishedItem } from "@bigbud/contracts/workspace/terminal.activity.ts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** Monotonic: an older coalesced write never moves recency backwards. */
export const writeTerminalRecency = (sql: SqlClient.SqlClient, threadId: string, at: string) =>
  sql<{ threadId: string }>`UPDATE projection_threads SET latest_terminal_activity_at = ${at}
    WHERE thread_id = ${threadId} AND deleted_at IS NULL
      AND (latest_terminal_activity_at IS NULL OR latest_terminal_activity_at < ${at})
    RETURNING thread_id AS "threadId"`.pipe(Effect.map((rows) => rows.length > 0));

export const upsertTerminalFinished = (
  sql: SqlClient.SqlClient,
  threadId: string,
  item: TerminalFinishedItem,
) =>
  sql<{ threadId: string }>`INSERT INTO terminal_finished_attention
      (thread_id, terminal_id, finished_at, command, exit_code, duration_ms, source)
    SELECT ${threadId}, ${item.terminalId}, ${item.finishedAt}, ${item.command ?? null},
      ${item.exitCode}, ${item.durationMs}, ${item.source}
    WHERE EXISTS (SELECT 1 FROM projection_threads WHERE thread_id = ${threadId}
      AND deleted_at IS NULL AND purpose = 'standard')
    ON CONFLICT (thread_id, terminal_id) DO UPDATE SET finished_at = excluded.finished_at,
      command = excluded.command, exit_code = excluded.exit_code,
      duration_ms = excluded.duration_ms, source = excluded.source
    RETURNING thread_id AS "threadId"`.pipe(Effect.map((rows) => rows.length > 0));

/** Clears one pane, or every pane of the thread when `terminalId` is omitted. */
export const clearTerminalFinished = (
  sql: SqlClient.SqlClient,
  threadId: string,
  terminalId?: string,
) =>
  sql<{ terminalId: string }>`DELETE FROM terminal_finished_attention
    WHERE thread_id = ${threadId}
      AND ${terminalId === undefined ? sql`1 = 1` : sql`terminal_id = ${terminalId}`}
    RETURNING terminal_id AS "terminalId"`.pipe(
    Effect.map((rows) => rows.map((row) => row.terminalId)),
  );

/** Items of deleted or missing threads can never be cleared by opening the thread. */
export const pruneTerminalFinished = (sql: SqlClient.SqlClient) =>
  sql`DELETE FROM terminal_finished_attention WHERE NOT EXISTS (
    SELECT 1 FROM projection_threads t WHERE t.thread_id = terminal_finished_attention.thread_id
      AND t.deleted_at IS NULL)`.pipe(Effect.asVoid);

export const countTerminalFinished = (sql: SqlClient.SqlClient, threadId: string) =>
  sql<{ count: number }>`SELECT COUNT(*) AS count FROM terminal_finished_attention
    WHERE thread_id = ${threadId}`.pipe(Effect.map((rows) => rows[0]?.count ?? 0));

export const listRaisedTerminalThreads = (sql: SqlClient.SqlClient) =>
  sql<{ threadId: string }>`SELECT DISTINCT thread_id AS "threadId"
    FROM terminal_finished_attention`.pipe(Effect.map((rows) => rows.map((row) => row.threadId)));
