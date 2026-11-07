/**
 * One event-log maintenance tick: read the load signals, decide how much may run, read the
 * floor, run a batch round, then record backlog, starvation and failures in the state row.
 *
 * Failures never escape: the failed batch's transaction rolled back, the error is recorded
 * and maintenance backs off for 15 minutes. A crash mid-batch leaves the database as it was;
 * the next tick resumes from `retained_through_sequence` and the stored receipt cursor.
 *
 * @module EventLogMaintenance.tick
 */
import { Cause, Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { TRACE_RETAIN_ATTRIBUTE } from "../../observability/TracePolicy.ts";
import type { OrchestrationEventStoreError, ProjectionRepositoryError } from "../Errors.ts";
import type { EventLogMaintenanceTickReport } from "../Services/EventLogMaintenance.ts";
import {
  type CompactBatchResult,
  type MaintenanceBatchKind,
  runBatchRound,
} from "./EventLogMaintenance.batches.ts";
import { maybeRefreshBaseline } from "./EventLogMaintenance.baselineRefresh.ts";
import { isEventLogFloorPinned, readEventLogFloor } from "./EventLogMaintenance.floor.ts";
import {
  type BatchSizer,
  DeletionRate,
  decideTick,
  MAINTENANCE_BATCH,
  MAINTENANCE_FAILURE_BACKOFF_MS,
  type MaintenanceLoadSignals,
  updateBacklogWatermark,
} from "./EventLogMaintenance.scheduler.ts";
import {
  type EventLogMaintenanceState,
  writeEventLogMaintenanceState,
} from "./EventLogMaintenance.state.ts";

export const SLOW_BATCH_SPAN = "event_log.maintenance.slow_batch";
export const STARVED_SPAN = "event_log.maintenance.starved";
export const FLOOR_PINNED_SPAN = "event_log.maintenance.floor_pinned";
const ERROR_LIMIT = 500;

export interface MaintenanceRuntime {
  readonly sql: SqlClient.SqlClient;
  readonly compact: (
    batchSize: number,
    throughSequence: number,
  ) => Effect.Effect<CompactBatchResult, OrchestrationEventStoreError>;
  readonly readSignals: (batchInFlight: boolean) => Effect.Effect<MaintenanceLoadSignals>;
  readonly floorInputs: () => {
    readonly reactorCursor: number | null;
    readonly deliveryAcknowledged: number | null;
  };
  readonly hotWindow?: { readonly sequences: number; readonly ms: number };
  /** Captures and verifies a baseline covering the sequence (see `EventLogMaintenance.baselineRefresh`). */
  readonly refreshBaseline?: (
    throughSequence: number,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Read the floor and report, but delete nothing (`BIGBUD_DISABLE_EVENT_LOG_MAINTENANCE`). */
  readonly batchesDisabled?: boolean;
  /** Wall clock, epoch ms. */
  readonly now: () => number;
  /** Monotonic clock for batch timing, ms. */
  readonly clock: () => number;
  /** Observes every batch (diagnostics and measurement harnesses). */
  readonly onBatch?: (
    kind: MaintenanceBatchKind,
    elapsedMs: number,
    rows: number,
    size: number,
    checkpointMs: number,
  ) => void;
}

/** In-memory state owned by the single maintenance fiber. */
export interface MaintenanceMemory {
  state: EventLogMaintenanceState;
  readonly sizers: Record<MaintenanceBatchKind, BatchSizer>;
  readonly rate: DeletionRate;
  readonly startedAtMs: number;
  inFlight: boolean;
  /** When maintenance last tried to verify its own baseline; null when never. */
  baselineRefreshAtMs: number | null;
  ticks: number;
}

const emptyReport = (
  mode: EventLogMaintenanceTickReport["mode"],
  reason: string,
  state: EventLogMaintenanceState,
): EventLogMaintenanceTickReport => ({
  mode,
  reason,
  floorSequence: state.floorSequence,
  retainedThroughSequence: state.retainedThroughSequence,
  backlogSequences: state.backlogSequences,
  eventsDeleted: 0,
  gapsDeleted: 0,
  receiptsDeleted: 0,
  claimsDeleted: 0,
  eventIdsDeleted: 0,
  batches: 0,
  slowBatches: 0,
  longestBatchMs: 0,
  longestCheckpointMs: 0,
  elapsedMs: 0,
  drained: state.backlogSequences === 0,
  failed: false,
});

const retainedSpan = (name: string, attributes: Record<string, unknown>) =>
  Effect.void.pipe(
    Effect.withSpan(name, {
      root: true,
      attributes: { ...attributes, [TRACE_RETAIN_ATTRIBUTE]: true },
    }),
  );

export const runMaintenanceTick = Effect.fn("EventLogMaintenance.tick")(function* (
  runtime: MaintenanceRuntime,
  memory: MaintenanceMemory,
) {
  const startedAt = runtime.clock();
  const nowMs = runtime.now();
  memory.ticks += 1;
  const signals = yield* runtime.readSignals(memory.inFlight);
  const decision = decideTick({
    nowMs,
    signals,
    backlog: memory.state.backlogSequences,
    lastProgressAtMs: memory.state.lastBatchAtMs ?? memory.startedAtMs,
    backoffUntilMs: memory.state.backoffUntilMs,
  });
  if (decision.mode === "skip-hard" || decision.mode === "backoff") {
    return emptyReport(decision.mode, decision.reason, memory.state);
  }
  memory.inFlight = true;
  return yield* Effect.gen(function* () {
    const readFloor = () =>
      readEventLogFloor(runtime.sql, {
        nowMs,
        ...runtime.floorInputs(),
        ...(runtime.hotWindow ? { hotWindow: runtime.hotWindow } : {}),
      });
    let floor = yield* readFloor();
    const refreshedAtMs =
      runtime.batchesDisabled === true
        ? null
        : yield* maybeRefreshBaseline({
            floor,
            mode: decision.mode,
            nowMs,
            lastAttemptAtMs: memory.baselineRefreshAtMs,
            refresh: runtime.refreshBaseline,
          });
    if (refreshedAtMs !== null) {
      memory.baselineRefreshAtMs = refreshedAtMs;
      floor = yield* readFloor();
    }
    let longestBatchMs = 0;
    let longestCheckpointMs = 0;
    const slowBatches: Array<{ kind: MaintenanceBatchKind; elapsedMs: number; rows: number }> = [];
    const round =
      decision.mode === "skip-soft" || runtime.batchesDisabled === true
        ? null
        : yield* runBatchRound({
            sql: runtime.sql,
            compact: runtime.compact,
            clock: runtime.clock,
            nowMs,
            floor: floor.floor,
            retainedThroughSequence: floor.retainedThroughSequence,
            receiptsCursor: memory.state.receiptsThroughSequence,
            orphanClaimsCursor: memory.state.orphanClaimsThroughRowid,
            orphanClaimsPassAtMs: memory.state.orphanClaimsPassAtMs,
            sizers: memory.sizers,
            mode: decision.mode === "minimum" ? "minimum" : "full",
            onBatch: (kind, elapsedMs, rows, size, checkpointMs) => {
              runtime.onBatch?.(kind, elapsedMs, rows, size, checkpointMs);
              longestBatchMs = Math.max(longestBatchMs, elapsedMs);
              longestCheckpointMs = Math.max(longestCheckpointMs, checkpointMs);
              // The transaction and its checkpoint each hold the worker; both must fit.
              if (Math.max(elapsedMs, checkpointMs) > MAINTENANCE_BATCH.targetMs)
                slowBatches.push({ kind, elapsedMs: Math.max(elapsedMs, checkpointMs), rows });
            },
          });
    const retained = round?.retainedThroughSequence ?? floor.retainedThroughSequence;
    const backlog = Math.max(0, floor.floor - retained);
    const watermark = updateBacklogWatermark(
      {
        lowWater: memory.state.lowWater,
        lowWaterAtMs: memory.state.lowWaterAtMs,
        starvedSinceMs: memory.state.starvedSinceMs,
      },
      backlog,
      nowMs,
    );
    if (round !== null) {
      memory.rate.record(nowMs, round.eventsDeleted);
    }
    const failed = round !== null && round.error !== null;
    const errorText = failed ? Cause.pretty(round.error as Cause.Cause<unknown>) : null;
    const previous = memory.state;
    memory.state = {
      ...previous,
      floorSequence: floor.floor,
      floorHeldBy: floor.heldBy,
      floorPinnedSinceMs: floor.pinnedSinceMs,
      retainedThroughSequence: retained,
      backlogSequences: backlog,
      lowWater: watermark.lowWater,
      lowWaterAtMs: watermark.lowWaterAtMs,
      starvedSinceMs: watermark.starvedSinceMs,
      lastBatchAtMs: round !== null && round.batches > 0 ? nowMs : previous.lastBatchAtMs,
      longestBatchMs: Math.max(previous.longestBatchMs, longestBatchMs),
      ratePerMinute: memory.rate.perMinute(nowMs),
      eventsDeleted: previous.eventsDeleted + (round?.eventsDeleted ?? 0),
      gapsDeleted: previous.gapsDeleted + (round?.gapsDeleted ?? 0),
      receiptsDeleted: previous.receiptsDeleted + (round?.receiptsDeleted ?? 0),
      claimsDeleted:
        previous.claimsDeleted + (round?.claimsDeleted ?? 0) + (round?.orphanClaimsDeleted ?? 0),
      eventIdsDeleted: previous.eventIdsDeleted + (round?.eventIdsDeleted ?? 0),
      receiptsThroughSequence: round?.receiptsCursor ?? previous.receiptsThroughSequence,
      orphanClaimsThroughRowid: round?.orphanClaimsCursor ?? previous.orphanClaimsThroughRowid,
      orphanClaimsPassAtMs:
        round === null ? previous.orphanClaimsPassAtMs : round.orphanClaimsPassAtMs,
      lastError: failed ? (errorText ?? "").slice(0, ERROR_LIMIT) : previous.lastError,
      lastErrorAtMs: failed ? nowMs : previous.lastErrorAtMs,
      backoffUntilMs: failed ? nowMs + MAINTENANCE_FAILURE_BACKOFF_MS : null,
    };
    yield* writeEventLogMaintenanceState(runtime.sql, memory.state, nowMs);
    for (const slow of slowBatches) {
      yield* retainedSpan(SLOW_BATCH_SPAN, {
        "maintenance.kind": slow.kind,
        "maintenance.batch_ms": Math.round(slow.elapsedMs),
        "maintenance.rows": slow.rows,
      });
    }
    if (failed) {
      yield* Effect.logWarning("event log maintenance batch failed; backing off", {
        detail: memory.state.lastError,
        backoffUntil: new Date(memory.state.backoffUntilMs ?? nowMs).toISOString(),
      });
    }
    if (
      isEventLogFloorPinned(floor.pinnedSinceMs, nowMs) &&
      !isEventLogFloorPinned(previous.floorPinnedSinceMs, nowMs)
    ) {
      const attributes = {
        "maintenance.floor_held_by": floor.heldBy,
        "maintenance.floor_sequence": floor.floor,
        "maintenance.floor_pinned_since": new Date(floor.pinnedSinceMs ?? nowMs).toISOString(),
      };
      yield* Effect.logWarning("event log maintenance floor is pinned for over 24 hours").pipe(
        Effect.annotateLogs(attributes),
      );
      yield* retainedSpan(FLOOR_PINNED_SPAN, attributes);
    }
    if (watermark.starvedSinceMs !== null && previous.starvedSinceMs === null) {
      const attributes = {
        "maintenance.backlog_sequences": backlog,
        "maintenance.floor_held_by": floor.heldBy,
        "maintenance.last_batch_at": new Date(memory.state.lastBatchAtMs ?? 0).toISOString(),
      };
      yield* Effect.logWarning("event log maintenance is starved: backlog grew for 24 hours").pipe(
        Effect.annotateLogs(attributes),
      );
      yield* retainedSpan(STARVED_SPAN, attributes);
    }
    return {
      mode: decision.mode,
      reason: decision.reason,
      floorSequence: floor.floor,
      retainedThroughSequence: retained,
      backlogSequences: backlog,
      eventsDeleted: round?.eventsDeleted ?? 0,
      gapsDeleted: round?.gapsDeleted ?? 0,
      receiptsDeleted: round?.receiptsDeleted ?? 0,
      claimsDeleted: (round?.claimsDeleted ?? 0) + (round?.orphanClaimsDeleted ?? 0),
      eventIdsDeleted: round?.eventIdsDeleted ?? 0,
      batches: round?.batches ?? 0,
      slowBatches: slowBatches.length,
      longestBatchMs,
      longestCheckpointMs,
      elapsedMs: runtime.clock() - startedAt,
      drained: round?.drained ?? backlog === 0,
      failed,
    } satisfies EventLogMaintenanceTickReport;
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        memory.inFlight = false;
      }),
    ),
  );
});
