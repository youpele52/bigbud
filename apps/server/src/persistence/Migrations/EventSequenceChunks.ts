/**
 * Runs a backfill over `orchestration_events` in bounded sequence ranges and
 * reports progress after each range, so a multi-gigabyte backfill is a series
 * of short statements with visible progress instead of one long scan.
 *
 * @module EventSequenceChunks
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { MigrationStepProgress } from "../MigrationProgress.ts";

/** Sequence values per statement. `sequence` is the rowid, so each range is a bounded scan. */
export const EVENT_BACKFILL_CHUNK_SIZE = 25_000;

export interface EventSequenceRange {
  readonly from: number;
  readonly to: number;
}

export const forEachEventSequenceChunk = Effect.fn("forEachEventSequenceChunk")(function* <R>(
  run: (range: EventSequenceRange) => Effect.Effect<unknown, SqlError, R>,
  chunkSize: number = EVENT_BACKFILL_CHUNK_SIZE,
) {
  const sql = yield* SqlClient.SqlClient;
  const report = yield* MigrationStepProgress;
  const [bounds] = yield* sql<{ readonly min: number | null; readonly max: number | null }>`
    SELECT MIN(sequence) AS "min", MAX(sequence) AS "max" FROM orchestration_events
  `;
  const min = bounds?.min ?? null;
  const max = bounds?.max ?? null;
  if (min === null || max === null) return yield* report(1);
  const span = max - min + 1;
  for (let from = min; from <= max; from += chunkSize) {
    const to = Math.min(max, from + chunkSize - 1);
    yield* run({ from, to });
    yield* report((to - min + 1) / span);
  }
});
