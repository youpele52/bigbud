/**
 * The batch rounds of one maintenance tick. Each batch is one short transaction whose size is
 * predicted (`BatchSizer`) to stay at or under 50 ms and under the WAL autocheckpoint size;
 * a PASSIVE checkpoint follows every batch as its own short step, so no batch commit ever runs
 * a checkpoint. In full mode another one precedes each batch, so the sizer learns from the
 * batch's own WAL frames rather than other writers' (`batchWalFrames`). The fiber yields between batches. A full pass interleaves events, gap rows,
 * event IDs, receipts and orphan claims, each with its own sizer, until all are drained or the
 * 1-second budget is spent; a minimum pass runs a single 100-row batch and one checkpoint, of
 * the next kind in `MINIMUM_BATCH_ROTATION`.
 *
 * @module EventLogMaintenance.batches
 */
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { type OrchestrationEventStoreError, toPersistenceSqlError } from "../Errors.ts";
import { pruneEventIds, pruneGapRows } from "./EventLogMaintenance.ledgers.ts";
import { pruneOrphanClaims, pruneReceipts } from "./EventLogMaintenance.receipts.ts";
import {
  MAINTENANCE_BATCH,
  MAINTENANCE_TICK_BUDGET_MS,
  BatchSizer,
  batchWalFrames,
  type WalCheckpointResult,
} from "./EventLogMaintenance.scheduler.ts";

export type MaintenanceBatchKind = "events" | "gaps" | "eventIds" | "receipts" | "orphanClaims";
export const MAINTENANCE_BATCH_KINDS: ReadonlyArray<MaintenanceBatchKind> = [
  "events",
  "gaps",
  "eventIds",
  "receipts",
  "orphanClaims",
];
/**
 * What successive guaranteed-progress (minimum) ticks run, one batch each: events every other
 * tick, since they are the backlog the floor measures, and each ledger kind in between. A kind
 * with nothing to do (a finished orphan-claim pass) is skipped to the next.
 */
export const MINIMUM_BATCH_ROTATION: ReadonlyArray<MaintenanceBatchKind> = [
  "events",
  "gaps",
  "events",
  "eventIds",
  "events",
  "receipts",
  "events",
  "orphanClaims",
];
/**
 * Claims examined per orphan-claim batch, at most. A pass mostly reads claims that still have a
 * receipt and deletes nothing, so the sizer would grow to 5,000; a cold 5,000-claim read took
 * 108 ms on the real 8 GB database (~0.02 ms a claim).
 */
export const ORPHAN_CLAIM_BATCH_MAX = 1_000;
/** Other deletion paths can orphan claims below the cursor, so passes repeat this often. */
export const ORPHAN_CLAIM_PASS_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * The receipt cursor passes receipts kept on purpose (`keptCommandSql`); once the reason ends
 * (a bootstrap finishes), only a rescan from the start prunes them. Below the cursor only such
 * receipts remain, so a rescan reads just those before it catches up.
 */
export const RECEIPT_RESCAN_INTERVAL_MS = 24 * 60 * 60_000;

/** A rescan runs on the first full tick of a process and then once a day. */
export const isReceiptRescanDue = (lastRescanAtMs: number | null, nowMs: number) =>
  lastRescanAtMs === null || nowMs - lastRescanAtMs >= RECEIPT_RESCAN_INTERVAL_MS;

export interface CompactBatchResult {
  readonly deletedCount: number;
  readonly retainedThroughSequence: number;
  readonly complete: boolean;
}

export interface BatchRoundInput {
  readonly sql: SqlClient.SqlClient;
  readonly compact: (
    batchSize: number,
    throughSequence: number,
  ) => Effect.Effect<CompactBatchResult, OrchestrationEventStoreError>;
  readonly clock: () => number;
  readonly nowMs: number;
  readonly floor: number;
  readonly retainedThroughSequence: number;
  readonly receiptsCursor: number;
  readonly orphanClaimsCursor: number;
  readonly orphanClaimsPassAtMs: number | null;
  /** Learned batch sizes, updated in place so the next tick starts from them. */
  readonly sizers: Record<MaintenanceBatchKind, BatchSizer>;
  readonly mode: "full" | "minimum";
  /** Position in `MINIMUM_BATCH_ROTATION` of the next minimum batch. */
  readonly minimumTurn: number;
  readonly onBatch: (
    kind: MaintenanceBatchKind,
    elapsedMs: number,
    rows: number,
    size: number,
    checkpointMs: number,
  ) => void;
}

export interface BatchRoundResult {
  readonly eventsDeleted: number;
  readonly gapsDeleted: number;
  readonly eventIdsDeleted: number;
  readonly receiptsDeleted: number;
  readonly claimsDeleted: number;
  readonly orphanClaimsDeleted: number;
  readonly retainedThroughSequence: number;
  readonly receiptsCursor: number;
  readonly orphanClaimsCursor: number;
  readonly orphanClaimsPassAtMs: number | null;
  readonly batches: number;
  readonly drained: boolean;
  readonly error: unknown;
  /** Position in `MINIMUM_BATCH_ROTATION` for the next minimum pass. */
  readonly minimumTurn: number;
}

export const initialBatchSizers = (): Record<MaintenanceBatchKind, BatchSizer> => ({
  events: new BatchSizer(),
  gaps: new BatchSizer(),
  eventIds: new BatchSizer(),
  receipts: new BatchSizer(),
  orphanClaims: new BatchSizer(ORPHAN_CLAIM_BATCH_MAX),
});

/**
 * Copies the WAL back into the database without waiting for readers. Returns the WAL's frame
 * count and how many frames are now copied back, or null when the database is not in WAL mode.
 */
const checkpointWal = (sql: SqlClient.SqlClient) =>
  sql<{ readonly log: number; readonly checkpointed: number }>`PRAGMA wal_checkpoint(PASSIVE)`.pipe(
    Effect.map((rows): WalCheckpointResult | null => {
      const log = Number(rows[0]?.log ?? -1);
      const checkpointed = Number(rows[0]?.checkpointed ?? -1);
      return log >= 0 && checkpointed >= 0 ? { log, checkpointed } : null;
    }),
    Effect.mapError(toPersistenceSqlError("EventLogMaintenance.checkpointWal")),
  );

/** Never fails: a failed batch's transaction rolled back, and the error is returned. */
export const runBatchRound = Effect.fn("EventLogMaintenance.runBatchRound")(function* (
  input: BatchRoundInput,
) {
  const deadline = input.clock() + MAINTENANCE_TICK_BUDGET_MS;
  const lastElapsed: Record<MaintenanceBatchKind, number> = {
    events: 0,
    gaps: 0,
    eventIds: 0,
    receipts: 0,
    orphanClaims: 0,
  };
  // A finished orphan-claim pass waits a day; then the next one starts from the first claim.
  const passDue =
    input.orphanClaimsPassAtMs !== null &&
    input.nowMs - input.orphanClaimsPassAtMs >= ORPHAN_CLAIM_PASS_INTERVAL_MS;
  let orphanClaimsCursor = passDue ? 0 : input.orphanClaimsCursor;
  let orphanClaimsPassAtMs = passDue ? null : input.orphanClaimsPassAtMs;
  const done: Record<MaintenanceBatchKind, boolean> = {
    events: false,
    gaps: false,
    eventIds: false,
    receipts: false,
    orphanClaims: orphanClaimsPassAtMs !== null,
  };
  let retained = input.retainedThroughSequence;
  let receiptsCursor = input.receiptsCursor;
  const totals = {
    events: 0,
    gaps: 0,
    eventIds: 0,
    receipts: 0,
    claims: 0,
    orphanClaims: 0,
    batches: 0,
  };
  let error: unknown = null;

  const runOne = (kind: MaintenanceBatchKind, size: number) =>
    Effect.gen(function* () {
      // Full mode measures the batch's own WAL pages for the sizer: a checkpoint first takes
      // other writers' frames out of the count. Minimum mode does not size, so it skips this.
      const beforeStarted = input.clock();
      const before = input.mode === "full" ? yield* checkpointWal(input.sql) : null;
      const beforeMs = input.clock() - beforeStarted;
      const started = input.clock();
      let rows = 0;
      let finished = false;
      if (kind === "events") {
        const result = yield* input.compact(size, input.floor);
        rows = result.deletedCount;
        retained = Math.max(retained, result.retainedThroughSequence);
        finished = result.complete;
        totals.events += rows;
      } else if (kind === "gaps") {
        rows = yield* pruneGapRows(input.sql, retained, size);
        finished = rows < size;
        totals.gaps += rows;
      } else if (kind === "eventIds") {
        rows = yield* pruneEventIds(input.sql, retained, size);
        finished = rows < size;
        totals.eventIds += rows;
      } else if (kind === "orphanClaims") {
        const result = yield* pruneOrphanClaims(input.sql, {
          cursor: orphanClaimsCursor,
          floor: input.floor,
          limit: size,
          nowMs: input.nowMs,
        });
        rows = result.scanned;
        finished = result.passComplete;
        orphanClaimsCursor = result.cursor;
        if (result.passComplete) orphanClaimsPassAtMs = input.nowMs;
        totals.orphanClaims += result.claims;
      } else {
        const through = Math.min(input.floor, retained);
        const result = yield* pruneReceipts(input.sql, {
          cursor: receiptsCursor,
          throughSequence: through,
          limit: size,
        });
        rows = result.receipts;
        finished = result.cursor >= through;
        receiptsCursor = result.cursor;
        totals.receipts += result.receipts;
        totals.claims += result.claims;
      }
      const elapsedMs = input.clock() - started;
      const checkpointStarted = input.clock();
      const after = yield* checkpointWal(input.sql);
      // Each checkpoint is its own short worker hold; report the longer.
      const checkpointMs = Math.max(beforeMs, input.clock() - checkpointStarted);
      totals.batches += 1;
      lastElapsed[kind] = elapsedMs + beforeMs + (input.clock() - checkpointStarted);
      input.onBatch(kind, elapsedMs, rows, size, checkpointMs);
      if (input.mode === "full") {
        input.sizers[kind].record(rows, elapsedMs, batchWalFrames(before, after));
      }
      // Ledgers follow `retained_through`, so they are drained only once the events are. Orphan
      // claims do not follow the events.
      done[kind] = finished && (kind === "events" || kind === "orphanClaims" || done.events);
    });

  let minimumTurn = input.minimumTurn;
  if (input.mode === "minimum") {
    // One batch: the next kind in the rotation that still has work.
    const length = MINIMUM_BATCH_ROTATION.length;
    for (let step = 0; step < length; step += 1) {
      const turn = (((input.minimumTurn + step) % length) + length) % length;
      const kind = MINIMUM_BATCH_ROTATION[turn]!;
      if (done[kind]) continue;
      minimumTurn = turn + 1;
      const exit = yield* Effect.exit(runOne(kind, MAINTENANCE_BATCH.min));
      if (exit._tag === "Failure") error = exit.cause;
      break;
    }
  } else {
    // Interleaved rounds of every pending kind until all are drained or the budget is spent.
    let ranOutOfTime = false;
    while (error === null && !ranOutOfTime) {
      const pending = MAINTENANCE_BATCH_KINDS.filter((kind) => !done[kind]);
      if (pending.length === 0) break;
      for (const kind of pending) {
        if (input.clock() + lastElapsed[kind] >= deadline) {
          ranOutOfTime = true;
          break;
        }
        const exit = yield* Effect.exit(runOne(kind, input.sizers[kind].size));
        if (exit._tag === "Failure") {
          error = exit.cause;
          break;
        }
        yield* Effect.yieldNow;
      }
    }
  }

  return {
    eventsDeleted: totals.events,
    gapsDeleted: totals.gaps,
    eventIdsDeleted: totals.eventIds,
    receiptsDeleted: totals.receipts,
    claimsDeleted: totals.claims,
    orphanClaimsDeleted: totals.orphanClaims,
    retainedThroughSequence: retained,
    receiptsCursor,
    orphanClaimsCursor,
    orphanClaimsPassAtMs,
    batches: totals.batches,
    drained: MAINTENANCE_BATCH_KINDS.every((kind) => done[kind]),
    error,
    minimumTurn,
  } satisfies BatchRoundResult;
});
