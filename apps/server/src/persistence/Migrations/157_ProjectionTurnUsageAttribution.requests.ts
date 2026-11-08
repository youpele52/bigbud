import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventPersistedRowSchema } from "../Layers/OrchestrationEventStore.schemas.ts";
import { decodeEventCompat } from "../Layers/OrchestrationEventStore.utils.ts";
import { PROJECTION_BASELINE_FORMAT_VERSION } from "../ProjectionBaselineRows.ts";
import { deriveTurnRequestUsage } from "../ProjectionTurnRequestUsage.ts";
import {
  missingAttributionSql,
  REQUEST_USAGE_TABLE,
} from "./157_ProjectionTurnUsageAttribution.columns.ts";

const THREADS_TABLE = "temp.projection_turn_usage_threads";
const EVENTS_TABLE = "temp.projection_turn_usage_request_events";
const REQUEST_PAGE_ROWS = 500;

const baselineValue = (column: string) => `json_extract(b.row_json, '$.${column}')`;

/**
 * Threads with a turn still missing attribution, live or in a verified baseline that
 * `patchVerifiedBaselineTurnUsage` will patch (a turn may still be pending in the baseline).
 */
const STAGE_THREADS_SQL = `
  INSERT OR IGNORE INTO ${THREADS_TABLE} (thread_id)
  SELECT thread_id FROM projection_turns WHERE ${missingAttributionSql((column) => column)}
  UNION
  SELECT ${baselineValue("thread_id")} FROM projection_baselines AS p
  JOIN projection_baseline_rows AS b ON b.baseline_id = p.baseline_id
  WHERE p.verification_status = 'verified' AND p.format_version = ${PROJECTION_BASELINE_FORMAT_VERSION}
    AND b.table_name = 'projection_turns' AND ${missingAttributionSql(baselineValue)}
`;

/**
 * One page of a thread's `thread.turn-start-requested` events, as the event store reads them for
 * replay, through `idx_orch_events_stream_sequence`. On the 8.7 GB database the staged threads
 * hold 360 threads and about 700,000 index-located events, read once.
 */
export const THREAD_REQUESTS_SQL = `
  SELECT sequence, event_id AS "eventId", event_type AS "type",
    aggregate_kind AS "aggregateKind", stream_id AS "aggregateId", occurred_at AS "occurredAt",
    command_id AS "commandId", causation_event_id AS "causationEventId",
    correlation_id AS "correlationId", payload_json AS "payload", metadata_json AS "metadata"
  FROM orchestration_events
  WHERE aggregate_kind = 'thread' AND stream_id = ? AND sequence > ?
    AND event_type = 'thread.turn-start-requested'
  ORDER BY sequence LIMIT ?
`;

const decodePersistedRow = Schema.decodeUnknownEffect(OrchestrationEventPersistedRowSchema);

/**
 * Decodes a request row exactly as replay does (`decodeEventCompat`), so the projector and this
 * migration read the same payload: decoding defaults (`interactionMode`), trimmed ids, and the raw
 * payload kept for removed providers. Rows replay cannot decode are skipped.
 */
const recoverRequestUsage = (row: unknown) =>
  decodePersistedRow(row).pipe(
    Effect.flatMap(decodeEventCompat),
    Effect.map((event) => {
      if (event.type !== "thread.turn-start-requested") return [];
      const usage = deriveTurnRequestUsage(event.payload);
      return [
        event.payload.threadId,
        event.payload.messageId,
        event.payload.createdAt,
        usage.provider,
        usage.model,
        usage.interactionMode,
        usage.source,
      ];
    }),
    Effect.orElseSucceed(() => []),
  );

const stageThreadRequests = (sql: SqlClient.SqlClient, threadId: string) =>
  Effect.gen(function* () {
    let after = -1;
    for (;;) {
      const page = yield* sql.unsafe<{ readonly sequence: number }>(THREAD_REQUESTS_SQL, [
        threadId,
        after,
        REQUEST_PAGE_ROWS,
      ]);
      const values = (yield* Effect.forEach(page, recoverRequestUsage)).filter(
        (entry) => entry.length > 0,
      );
      if (values.length > 0) {
        yield* sql.unsafe(
          `INSERT INTO ${EVENTS_TABLE}
             (thread_id, message_id, requested_at, provider, model, mode, source)
           VALUES ${values.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
          values.flat(),
        );
      }
      if (page.length < REQUEST_PAGE_ROWS) return;
      after = page.at(-1)!.sequence;
    }
  });

/**
 * Fills `REQUEST_USAGE_TABLE` with the usage of every unambiguous request of the staged threads.
 * A request is ambiguous when its thread has several requests for the same prompt and request
 * time that recover different usage: the projector would attribute their turns in event order,
 * which a set-based backfill cannot reproduce, so they stay unattributed. Identical duplicates
 * recover the same usage whichever one a turn inherits, so they are kept.
 */
export const stageRequestUsage = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* dropRequestUsageTables(sql);
    yield* sql.unsafe(`CREATE TEMP TABLE projection_turn_usage_threads (
      thread_id TEXT PRIMARY KEY)`);
    yield* sql.unsafe(`CREATE TEMP TABLE projection_turn_usage_request_events (
      thread_id TEXT NOT NULL, message_id TEXT NOT NULL, requested_at TEXT NOT NULL,
      provider TEXT, model TEXT, mode TEXT, source TEXT)`);
    yield* sql.unsafe(`CREATE TEMP TABLE projection_turn_usage_requests (
      thread_id TEXT NOT NULL, message_id TEXT NOT NULL, requested_at TEXT NOT NULL,
      provider TEXT, model TEXT, mode TEXT, source TEXT,
      PRIMARY KEY (thread_id, message_id, requested_at))`);
    yield* sql.unsafe(STAGE_THREADS_SQL);
    const threads = yield* sql.unsafe<{ readonly threadId: string }>(
      `SELECT thread_id AS "threadId" FROM ${THREADS_TABLE} WHERE thread_id IS NOT NULL
       ORDER BY thread_id`,
    );
    for (const { threadId } of threads) yield* stageThreadRequests(sql, threadId);
    yield* sql.unsafe(`
      INSERT INTO ${REQUEST_USAGE_TABLE}
        (thread_id, message_id, requested_at, provider, model, mode, source)
      SELECT thread_id, message_id, requested_at, MIN(provider), MIN(model), MIN(mode), MIN(source)
      FROM ${EVENTS_TABLE}
      GROUP BY thread_id, message_id, requested_at
      HAVING COUNT(DISTINCT json_array(provider, model, mode, source)) = 1
    `);
  });

export const dropRequestUsageTables = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql.unsafe(`DROP TABLE IF EXISTS ${THREADS_TABLE}`);
    yield* sql.unsafe(`DROP TABLE IF EXISTS ${EVENTS_TABLE}`);
    yield* sql.unsafe(`DROP TABLE IF EXISTS ${REQUEST_USAGE_TABLE}`);
  });
