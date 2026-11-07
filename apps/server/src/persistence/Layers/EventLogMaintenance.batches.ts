/**
 * The batch rounds of one maintenance tick. Each batch is one short transaction whose size is
 * predicted (`BatchSizer`) to stay at or under 50 ms and under the WAL autocheckpoint size;
 * a PASSIVE checkpoint follows every batch as its own short step, so no batch commit ever runs
 * a checkpoint. The fiber yields between batches. A full pass interleaves events, gap rows,
 * event IDs, receipts and orphan claims, each with its own sizer, until all are drained or the
 * 1-second budget is spent; a minimum pass runs one 100-row batch of each.
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
 * Claims examined per orphan-claim batch, at most. A pass mostly reads claims that still have a
 * receipt and deletes nothing, so the sizer would grow to 5,000; a cold 5,000-claim read took
 * 108 ms on the real 8 GB database (~0.02 ms a claim).
 */
export const ORPHAN_CLAIM_BATCH_MAX = 1_000;
/** Other deletion paths can orphan claims below the cursor, so passes repeat this often. */
export const ORPHAN_CLAIM_PASS_INTERVAL_MS = 24 * 60 * 60_000;

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
  readonly receiptsBlockedUntilMs: number | null;
  readonly orphanClaimsCursor: number;
  readonly orphanClaimsPassAtMs: number | null;
  /** Learned batch sizes, updated in place so the next tick starts from them. */
  readonly sizers: Record<MaintenanceBatchKind, BatchSizer>;
  readonly mode: "full" | "minimum";
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
  readonly receiptsBlockedUntilMs: number | null;
  readonly orphanClaimsCursor: number;
  readonly orphanClaimsPassAtMs: number | null;
  readonly batches: number;
  readonly drained: boolean;
  readonly error: unknown;
}

export const initialBatchSizers = (): Record<MaintenanceBatchKind, BatchSizer> => ({
  events: new BatchSizer(),
  gaps: new BatchSizer(),
  eventIds: new BatchSizer(),
  receipts: new BatchSizer(),
  orphanClaims: new BatchSizer(ORPHAN_CLAIM_BATCH_MAX),
});

/**
 * Copies the WAL back into the database without waiting for readers. Returns the WAL frames
 * it found (the pages the batch just wrote, plus any other writer's since the last one), or
 * null when the database is not in WAL mode.
 */
const checkpointWal = (sql: SqlClient.SqlClient) =>
  sql<{ readonly log: number }>`PRAGMA wal_checkpoint(PASSIVE)`.pipe(
    Effect.map((rows) => {
      const log = Number(rows[0]?.log ?? -1);
      return log >= 0 ? log : null;
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
    receipts: input.receiptsBlockedUntilMs !== null && input.nowMs < input.receiptsBlockedUntilMs,
    orphanClaims: orphanClaimsPassAtMs !== null,
  };
  let retained = input.retainedThroughSequence;
  let receiptsCursor = input.receiptsCursor;
  let receiptsBlockedUntilMs = done.receipts ? input.receiptsBlockedUntilMs : null;
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
          nowMs: input.nowMs,
        });
        rows = result.receipts;
        finished = result.blockedUntilMs !== null || result.cursor >= through;
        receiptsCursor = result.cursor;
        receiptsBlockedUntilMs = result.blockedUntilMs;
        totals.receipts += result.receipts;
        totals.claims += result.claims;
      }
      const elapsedMs = input.clock() - started;
      const checkpointStarted = input.clock();
      const walPages = yield* checkpointWal(input.sql);
      const checkpointMs = input.clock() - checkpointStarted;
      totals.batches += 1;
      lastElapsed[kind] = elapsedMs + checkpointMs;
      input.onBatch(kind, elapsedMs, rows, size, checkpointMs);
      if (input.mode === "full") input.sizers[kind].record(rows, elapsedMs, walPages);
      // Ledgers follow `retained_through`, so they are drained only once the events are; a
      // receipt cursor waiting for a receipt to turn 7 days old is done for this tick. Orphan
      // claims do not follow the events.
      done[kind] =
        finished &&
        (kind === "events" ||
          kind === "orphanClaims" ||
          done.events ||
          (kind === "receipts" && receiptsBlockedUntilMs !== null));
    });

  const rounds = input.mode === "minimum" ? 1 : Number.POSITIVE_INFINITY;
  for (let round = 0; round < rounds && error === null; round += 1) {
    const pending = MAINTENANCE_BATCH_KINDS.filter((kind) => !done[kind]);
    if (pending.length === 0) break;
    let ranOutOfTime = false;
    for (const kind of pending) {
      if (input.mode === "full" && input.clock() + lastElapsed[kind] >= deadline) {
        ranOutOfTime = true;
        break;
      }
      const size = input.mode === "minimum" ? MAINTENANCE_BATCH.min : input.sizers[kind].size;
      const exit = yield* Effect.exit(runOne(kind, size));
      if (exit._tag === "Failure") {
        error = exit.cause;
        break;
      }
      yield* Effect.yieldNow;
    }
    if (ranOutOfTime) break;
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
    receiptsBlockedUntilMs,
    orphanClaimsCursor,
    orphanClaimsPassAtMs,
    batches: totals.batches,
    drained: MAINTENANCE_BATCH_KINDS.every((kind) => done[kind]),
    error,
  } satisfies BatchRoundResult;
});
