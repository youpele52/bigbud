/**
 * The single `event_log_maintenance_state` row (migrations 156 and 158): progress that must
 * survive a restart (backlog watermark, totals, the receipt and orphan-claim cursors, the failure
 * backoff) and that the
 * read-only size report prints. Timestamps are ISO strings in the row and epoch ms in memory.
 *
 * @module EventLogMaintenance.state
 */
import type { EventLogFloorHolder } from "@bigbud/contracts/server/eventLogMaintenance.ts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";

export interface EventLogMaintenanceState {
  readonly floorSequence: number;
  readonly floorHeldBy: EventLogFloorHolder | null;
  /**
   * When the current holder began pinning the floor (`EventLogMaintenance.floor`). Memory only:
   * every tick re-derives it from stored events, so it needs no column.
   */
  readonly floorPinnedSinceMs: number | null;
  readonly retainedThroughSequence: number;
  readonly backlogSequences: number;
  readonly lowWater: number;
  readonly lowWaterAtMs: number | null;
  readonly starvedSinceMs: number | null;
  readonly lastBatchAtMs: number | null;
  readonly longestBatchMs: number;
  readonly ratePerMinute: number;
  readonly eventsDeleted: number;
  readonly gapsDeleted: number;
  readonly receiptsDeleted: number;
  readonly claimsDeleted: number;
  readonly eventIdsDeleted: number;
  readonly receiptsThroughSequence: number;
  /** Orphan-claim pass cursor (claim rowid). */
  readonly orphanClaimsThroughRowid: number;
  /** When the last orphan-claim pass finished; null while one is in progress. */
  readonly orphanClaimsPassAtMs: number | null;
  readonly lastError: string | null;
  readonly lastErrorAtMs: number | null;
  readonly backoffUntilMs: number | null;
}

export const EMPTY_EVENT_LOG_MAINTENANCE_STATE: EventLogMaintenanceState = {
  floorSequence: 0,
  floorHeldBy: null,
  floorPinnedSinceMs: null,
  retainedThroughSequence: 0,
  backlogSequences: 0,
  lowWater: 0,
  lowWaterAtMs: null,
  starvedSinceMs: null,
  lastBatchAtMs: null,
  longestBatchMs: 0,
  ratePerMinute: 0,
  eventsDeleted: 0,
  gapsDeleted: 0,
  receiptsDeleted: 0,
  claimsDeleted: 0,
  eventIdsDeleted: 0,
  receiptsThroughSequence: 0,
  orphanClaimsThroughRowid: 0,
  orphanClaimsPassAtMs: null,
  lastError: null,
  lastErrorAtMs: null,
  backoffUntilMs: null,
};

const toMs = (value: string | null): number | null => {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const toIso = (value: number | null) => (value === null ? null : new Date(value).toISOString());

interface StateRow {
  readonly floorSequence: number;
  readonly floorHeldBy: string | null;
  readonly backlogSequences: number;
  readonly lowWater: number;
  readonly lowWaterAt: string | null;
  readonly starvedSince: string | null;
  readonly lastBatchAt: string | null;
  readonly ratePerMinute: number;
  readonly eventsDeleted: number;
  readonly gapsDeleted: number;
  readonly receiptsDeleted: number;
  readonly claimsDeleted: number;
  readonly eventIdsDeleted: number;
  readonly receiptsThroughSequence: number;
  readonly orphanClaimsThroughRowid: number;
  readonly orphanClaimsPassAt: string | null;
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
  readonly backoffUntil: string | null;
}

/** The longest batch is per process run, so it starts at 0 rather than at the stored value. */
export const readEventLogMaintenanceState = Effect.fn("EventLogMaintenance.readState")(
  function* (sql: SqlClient.SqlClient) {
    const [row] = yield* sql<StateRow>`
      SELECT floor_sequence AS "floorSequence", floor_held_by AS "floorHeldBy",
        backlog_sequences AS "backlogSequences", backlog_low_water AS "lowWater",
        backlog_low_water_at AS "lowWaterAt", starved_since AS "starvedSince",
        last_batch_at AS "lastBatchAt", rate_per_minute AS "ratePerMinute",
        events_deleted AS "eventsDeleted", gaps_deleted AS "gapsDeleted",
        receipts_deleted AS "receiptsDeleted", claims_deleted AS "claimsDeleted",
        event_ids_deleted AS "eventIdsDeleted",
        receipts_through_sequence AS "receiptsThroughSequence",
        orphan_claims_through_rowid AS "orphanClaimsThroughRowid",
        orphan_claims_pass_at AS "orphanClaimsPassAt",
        last_error AS "lastError", last_error_at AS "lastErrorAt",
        backoff_until AS "backoffUntil"
      FROM event_log_maintenance_state WHERE singleton_id = 1
    `;
    if (row === undefined) return EMPTY_EVENT_LOG_MAINTENANCE_STATE;
    return {
      ...EMPTY_EVENT_LOG_MAINTENANCE_STATE,
      floorSequence: row.floorSequence,
      floorHeldBy: row.floorHeldBy as EventLogFloorHolder | null,
      backlogSequences: row.backlogSequences,
      lowWater: row.lowWater,
      lowWaterAtMs: toMs(row.lowWaterAt),
      starvedSinceMs: toMs(row.starvedSince),
      lastBatchAtMs: toMs(row.lastBatchAt),
      ratePerMinute: row.ratePerMinute,
      eventsDeleted: row.eventsDeleted,
      gapsDeleted: row.gapsDeleted,
      receiptsDeleted: row.receiptsDeleted,
      claimsDeleted: row.claimsDeleted,
      eventIdsDeleted: row.eventIdsDeleted,
      receiptsThroughSequence: row.receiptsThroughSequence,
      orphanClaimsThroughRowid: row.orphanClaimsThroughRowid,
      orphanClaimsPassAtMs: toMs(row.orphanClaimsPassAt),
      lastError: row.lastError,
      lastErrorAtMs: toMs(row.lastErrorAt),
      backoffUntilMs: toMs(row.backoffUntil),
    } satisfies EventLogMaintenanceState;
  },
  Effect.mapError(toPersistenceSqlError("EventLogMaintenance.readState")),
);

export const writeEventLogMaintenanceState = Effect.fn("EventLogMaintenance.writeState")(
  function* (sql: SqlClient.SqlClient, state: EventLogMaintenanceState, nowMs: number) {
    yield* sql`
      INSERT INTO event_log_maintenance_state (
        singleton_id, floor_sequence, floor_held_by, backlog_sequences, backlog_low_water,
        backlog_low_water_at, starved, starved_since, last_batch_at, longest_batch_ms,
        rate_per_minute, events_deleted, gaps_deleted, receipts_deleted, claims_deleted,
        event_ids_deleted, receipts_through_sequence, orphan_claims_through_rowid,
        orphan_claims_pass_at, last_error, last_error_at, backoff_until, updated_at
      ) VALUES (
        1, ${state.floorSequence}, ${state.floorHeldBy}, ${state.backlogSequences},
        ${state.lowWater}, ${toIso(state.lowWaterAtMs)}, ${state.starvedSinceMs === null ? 0 : 1},
        ${toIso(state.starvedSinceMs)}, ${toIso(state.lastBatchAtMs)}, ${state.longestBatchMs},
        ${state.ratePerMinute}, ${state.eventsDeleted}, ${state.gapsDeleted},
        ${state.receiptsDeleted}, ${state.claimsDeleted}, ${state.eventIdsDeleted},
        ${state.receiptsThroughSequence}, ${state.orphanClaimsThroughRowid},
        ${toIso(state.orphanClaimsPassAtMs)}, ${state.lastError}, ${toIso(state.lastErrorAtMs)},
        ${toIso(state.backoffUntilMs)}, ${new Date(nowMs).toISOString()}
      )
      ON CONFLICT (singleton_id) DO UPDATE SET
        floor_sequence = excluded.floor_sequence, floor_held_by = excluded.floor_held_by,
        backlog_sequences = excluded.backlog_sequences,
        backlog_low_water = excluded.backlog_low_water,
        backlog_low_water_at = excluded.backlog_low_water_at, starved = excluded.starved,
        starved_since = excluded.starved_since, last_batch_at = excluded.last_batch_at,
        longest_batch_ms = excluded.longest_batch_ms, rate_per_minute = excluded.rate_per_minute,
        events_deleted = excluded.events_deleted, gaps_deleted = excluded.gaps_deleted,
        receipts_deleted = excluded.receipts_deleted, claims_deleted = excluded.claims_deleted,
        event_ids_deleted = excluded.event_ids_deleted,
        receipts_through_sequence = excluded.receipts_through_sequence,
        orphan_claims_through_rowid = excluded.orphan_claims_through_rowid,
        orphan_claims_pass_at = excluded.orphan_claims_pass_at,
        last_error = excluded.last_error, last_error_at = excluded.last_error_at,
        backoff_until = excluded.backoff_until, updated_at = excluded.updated_at
    `;
  },
  Effect.mapError(toPersistenceSqlError("EventLogMaintenance.writeState")),
);
