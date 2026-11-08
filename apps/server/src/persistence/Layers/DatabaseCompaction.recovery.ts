/**
 * What a run that did not report back means, and how failures are described.
 *
 * `VACUUM` is atomic, so a crash mid-run leaves either the old or the rebuilt file. The marker
 * records the `auto_vacuum` mode before the run; the rebuild switches it to `INCREMENTAL`:
 *
 * - still not incremental: the rebuild never committed, so the database was not changed;
 * - incremental now, but not before: the rebuild committed (`completed`);
 * - incremental before (or the marker is unreadable): both endings look alike, so the outcome
 *   is reported as unknown rather than guessed.
 *
 * @module DatabaseCompaction.recovery
 */
import type { DatabaseCompactionRun } from "@bigbud/contracts/server/databaseCompaction.ts";
import { Cause, Effect, Option } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { RecoveredCompactionMarker } from "./DatabaseCompaction.marker.ts";
import { readFileSizes, readPageStats } from "./DatabaseCompaction.stats.ts";

export const toIso = (ms: number) => new Date(ms).toISOString();

export const INTERRUPTED_UNCHANGED =
  "The backend stopped during compaction. The database was not changed.";
export const INTERRUPTED_UNKNOWN =
  "The backend stopped during compaction, and bigbud cannot tell whether the rebuild finished. SQLite kept the database consistent either way.";

/** The SQLite message sits under the SQL error's reason and cause; keep each distinct level. */
export const describeCause = (cause: Cause.Cause<unknown>) => {
  const messages: Array<string> = [];
  let current: unknown = Cause.squash(cause);
  for (let depth = 0; current !== undefined && current !== null && depth < 6; depth += 1) {
    if (typeof current !== "object") {
      messages.push(String(current));
      break;
    }
    const {
      message,
      reason,
      cause: inner,
    } = current as {
      readonly message?: unknown;
      readonly reason?: unknown;
      readonly cause?: unknown;
    };
    if (typeof message === "string" && message.trim() && !messages.includes(message.trim()))
      messages.push(message.trim());
    current = reason ?? inner;
  }
  return (messages.join(": ") || "Database compaction failed.").slice(0, 500);
};

/** What a marker left by an earlier process says about the run it recorded. */
export const recoverRun = Effect.fn("DatabaseCompaction.recoverRun")(function* (
  sql: SqlClient.SqlClient,
  dbPath: string,
  marker: RecoveredCompactionMarker,
  nowMs: number,
) {
  const stats = yield* readPageStats(sql).pipe(Effect.option);
  const sizes = yield* readFileSizes(dbPath);
  const incrementalNow = Option.isSome(stats) && stats.value.autoVacuum === "incremental";
  const notIncrementalNow = Option.isSome(stats) && stats.value.autoVacuum !== "incremental";
  const before = marker.autoVacuumBefore;
  const completed = incrementalNow && (before === "none" || before === "full");
  const run: DatabaseCompactionRun = {
    outcome: completed ? "completed" : "interrupted",
    startedAt: marker.startedAt ?? marker.recordedAt ?? toIso(nowMs),
    finishedAt: completed ? null : toIso(nowMs),
    bytesBefore: marker.bytesBefore,
    bytesAfter: completed ? sizes.fileBytes : null,
    checkpointComplete: completed && sizes.walBytes === 0,
    error: completed ? null : notIncrementalNow ? INTERRUPTED_UNCHANGED : INTERRUPTED_UNKNOWN,
  };
  yield* Effect.logWarning("database compaction from an earlier run did not report back", {
    outcome: run.outcome,
    startedAt: run.startedAt,
    markerValid: marker.startedAt !== null && before !== null,
  });
  return run;
});
