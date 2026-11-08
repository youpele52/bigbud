/**
 * Shared fixtures for the EventLogMaintenance tests: synthetic canonical events, receipts and
 * claims written with set-based SQL (so 200,000 rows seed in well under a second), a verified
 * baseline marker and projector cursors.
 */
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { MaintenanceLoadSignals } from "./EventLogMaintenance.scheduler.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const NOW_MS = Date.parse("2026-11-07T12:00:00.000Z");

export const IDLE_SIGNALS: MaintenanceLoadSignals = {
  queueDepth: 0,
  eventLoopLagged: false,
  streamingTurns: 0,
  backgroundActive: 0,
  batchInFlight: false,
  databaseCompactionRunning: false,
};

/** A small hot window, so a few thousand events are enough to exercise compaction. */
export const TEST_HOT_WINDOW = { sequences: 100, ms: 60_000 } as const;

/**
 * Appends `count` thread events after the current head. Each event is `ageMs` old (relative
 * to `nowMs`), and its event ID is also reserved in `orchestration_event_ids`.
 */
/**
 * Command and event IDs. `scatter` spreads them over their indexes like the random IDs of the
 * real log, so deleting a run of sequences dirties index pages the way production does.
 */
const idSql = (sql: SqlClient.SqlClient, prefix: string, scatter: boolean | undefined) =>
  sql.unsafe(
    scatter
      ? `'${prefix}-' || printf('%08x', (value * 2654435761) % 4294967296) || '-' || value`
      : `'${prefix}-' || value`,
  );

export const seedEvents = (
  sql: SqlClient.SqlClient,
  input: {
    readonly count: number;
    readonly nowMs?: number;
    readonly ageMs?: number;
    readonly scatter?: boolean;
  },
) =>
  Effect.gen(function* () {
    const occurredAt = new Date(
      (input.nowMs ?? NOW_MS) - (input.ageMs ?? 3 * DAY_MS),
    ).toISOString();
    const [head] = yield* sql<{ readonly head: number }>`
      SELECT COALESCE(MAX(sequence), 0) AS "head" FROM orchestration_events
    `;
    const start = (head?.head ?? 0) + 1;
    const end = start + input.count - 1;
    yield* sql`
      WITH RECURSIVE seq(value) AS (SELECT CAST(${start} AS INTEGER) UNION ALL SELECT value + 1 FROM seq WHERE value < ${end})
      INSERT INTO orchestration_events (
        sequence, event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
      )
      SELECT value, ${idSql(sql, "event", input.scatter)}, 'thread', 'thread-' || (value % 50),
        value, 'thread.archived', ${occurredAt}, ${idSql(sql, "command", input.scatter)}, NULL,
        ${idSql(sql, "command", input.scatter)},
        'server', json_object('threadId', 'thread-' || (value % 50), 'archivedAt', ${occurredAt},
          'updatedAt', ${occurredAt}, 'padding', hex(randomblob(48))), '{}'
      FROM seq
    `;
    yield* sql`
      INSERT INTO orchestration_event_ids (event_id, sequence)
      SELECT event_id, sequence FROM orchestration_events
      WHERE sequence BETWEEN ${start} AND ${end}
    `;
    return { start, end };
  });

/** One receipt and one claim per event command in [start, end], accepted `ageMs` ago. */
export const seedReceipts = (
  sql: SqlClient.SqlClient,
  input: {
    readonly start: number;
    readonly end: number;
    readonly nowMs?: number;
    readonly ageMs?: number;
    readonly scatter?: boolean;
  },
) =>
  Effect.gen(function* () {
    const acceptedAt = new Date(
      (input.nowMs ?? NOW_MS) - (input.ageMs ?? 8 * DAY_MS),
    ).toISOString();
    yield* sql`
      WITH RECURSIVE seq(value) AS (
        SELECT CAST(${input.start} AS INTEGER) UNION ALL SELECT value + 1 FROM seq WHERE value < ${input.end}
      )
      INSERT INTO orchestration_command_receipts (
        command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error
      )
      SELECT ${idSql(sql, "command", input.scatter)}, 'thread', 'thread-' || (value % 50),
        ${acceptedAt}, value,
        'accepted', NULL
      FROM seq
    `;
    yield* sql`
      WITH RECURSIVE seq(value) AS (
        SELECT CAST(${input.start} AS INTEGER) UNION ALL SELECT value + 1 FROM seq WHERE value < ${input.end}
      )
      INSERT INTO orchestration_command_receipt_claims (
        command_id, payload_digest_version, payload_digest, claimed_at
      )
      SELECT ${idSql(sql, "command", input.scatter)}, 'v1', 'digest-' || value, ${acceptedAt}
      FROM seq
    `;
  });

/** Marks a verified baseline at `sequence` (sequence-only marker; no payload is read). */
export const verifyBaselineThrough = (sql: SqlClient.SqlClient, sequence: number) =>
  Effect.gen(function* () {
    const now = new Date(NOW_MS).toISOString();
    yield* sql`
      INSERT INTO projection_baselines (
        sequence, format_version, payload_json, payload_hash, verification_status,
        verification_detail, created_at, verified_at
      ) VALUES (${sequence}, 1, '{}', 'proof', 'verified', NULL, ${now}, ${now})
      ON CONFLICT (sequence) DO NOTHING
    `;
    yield* sql`
      UPDATE orchestration_retention_state
      SET compact_through_sequence = MAX(compact_through_sequence, ${sequence})
      WHERE singleton_id = 1
    `;
  });

export const setProjectorCursors = (sql: SqlClient.SqlClient, sequence: number) =>
  sql`
    INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
    VALUES ('projection.threads', ${sequence}, '2026-11-07T00:00:00.000Z'),
      ('projection.thread-messages', ${sequence}, '2026-11-07T00:00:00.000Z')
    ON CONFLICT (projector) DO UPDATE SET last_applied_sequence = excluded.last_applied_sequence
  `;

/** Events, receipts, a baseline and projector cursors covering the whole log. */
export const seedCompactableLog = (
  sql: SqlClient.SqlClient,
  input: { readonly count: number; readonly receipts?: boolean; readonly scatter?: boolean },
) =>
  Effect.gen(function* () {
    const scatter = input.scatter === true;
    const range = yield* seedEvents(sql, { count: input.count, scatter });
    if (input.receipts !== false) yield* seedReceipts(sql, { ...range, scatter });
    yield* verifyBaselineThrough(sql, range.end);
    yield* setProjectorCursors(sql, range.end);
    return range;
  });

export const countRows = (sql: SqlClient.SqlClient, table: string) =>
  sql
    .unsafe<{ readonly count: number }>(`SELECT COUNT(*) AS "count" FROM ${table}`)
    .pipe(Effect.map((rows) => rows[0]?.count ?? 0));

export const readRetention = (sql: SqlClient.SqlClient) =>
  sql<{ readonly retained: number; readonly compact: number }>`
    SELECT retained_through_sequence AS "retained", compact_through_sequence AS "compact"
    FROM orchestration_retention_state WHERE singleton_id = 1
  `.pipe(Effect.map((rows) => rows[0] ?? { retained: 0, compact: 0 }));
