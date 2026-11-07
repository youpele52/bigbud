/**
 * One bounded steady-state step, for the maintenance scheduler to call between batches:
 *
 * - `journal_size_limit = 64 MB` on the write connection, once per connection;
 * - `PRAGMA incremental_vacuum(1024)` (about 4 MB) when free pages exceed 10%, only once the file
 *   is in `INCREMENTAL` mode (after the one-time rebuild);
 * - `PRAGMA wal_checkpoint(TRUNCATE)` when idle, with `busy_timeout = 0` so a reader makes it
 *   return at once instead of holding the worker for the 5-second busy timeout.
 *
 * Statements run on one reserved connection, so the temporary `busy_timeout` is never seen by
 * another statement, and it is restored however the step ends.
 *
 * @module DatabaseCompaction.steadyState
 */
import { Cause, Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";

import type {
  DatabaseSteadyStateStepInput,
  DatabaseSteadyStateStepReport,
} from "../Services/DatabaseCompaction.ts";
import {
  freeFraction,
  shouldRunIncrementalVacuum,
  STEADY_STATE,
  toAutoVacuumMode,
} from "./DatabaseCompaction.policy.ts";
import {
  execute,
  firstValue,
  truncateWalWithBusyTimeout,
  type WalCheckpointResult,
} from "./DatabaseCompaction.vacuum.ts";

export interface SteadyStateMemory {
  /** The write connection already carries `journal_size_limit`. */
  journalSizeLimitApplied: boolean;
}

export const applyJournalSizeLimit = (connection: Connection) =>
  execute(connection, `PRAGMA journal_size_limit = ${STEADY_STATE.journalSizeLimitBytes}`);

const readStats = (connection: Connection) =>
  Effect.gen(function* () {
    const pageCount = firstValue(yield* execute(connection, "PRAGMA page_count"));
    const freelistCount = firstValue(yield* execute(connection, "PRAGMA freelist_count"));
    const autoVacuum = toAutoVacuumMode(
      firstValue(yield* execute(connection, "PRAGMA auto_vacuum")),
    );
    return { pageSize: 0, pageCount, freelistCount, autoVacuum };
  });

export interface SteadyStateRuntime {
  readonly sql: SqlClient.SqlClient;
  readonly memory: SteadyStateMemory;
  /** True while the one-time rebuild runs; the step then does nothing. */
  readonly compactionRunning: () => boolean;
  /** Default idle rule when the caller passes none. */
  readonly defaultIdle: Effect.Effect<boolean>;
  readonly clock: () => number;
}

export const runSteadyStateStep = (
  runtime: SteadyStateRuntime,
  input: DatabaseSteadyStateStepInput = {},
): Effect.Effect<DatabaseSteadyStateStepReport> =>
  Effect.gen(function* () {
    const startedAt = runtime.clock();
    const report = {
      skipped: null as DatabaseSteadyStateStepReport["skipped"],
      journalSizeLimitApplied: false,
      autoVacuumIncremental: false,
      freeFractionBefore: 0,
      pagesReleased: 0,
      checkpoint: null as WalCheckpointResult | null,
      error: null as string | null,
    };
    const finish = () => ({ ...report, elapsedMs: runtime.clock() - startedAt });
    if (runtime.compactionRunning()) {
      report.skipped = "compaction-running";
      return finish();
    }
    // Decided before reserving the connection: the default rule reads the database itself.
    const idle = input.idle ?? (yield* runtime.defaultIdle);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* runtime.sql.reserve;
        if (!runtime.memory.journalSizeLimitApplied) {
          yield* applyJournalSizeLimit(connection);
          runtime.memory.journalSizeLimitApplied = true;
          report.journalSizeLimitApplied = true;
        }
        const before = yield* readStats(connection);
        report.autoVacuumIncremental = before.autoVacuum === "incremental";
        report.freeFractionBefore = freeFraction(before);
        if (shouldRunIncrementalVacuum(before)) {
          yield* execute(connection, `PRAGMA incremental_vacuum(${STEADY_STATE.incrementalPages})`);
          const after = firstValue(yield* execute(connection, "PRAGMA freelist_count"));
          report.pagesReleased = Math.max(0, before.freelistCount - after);
        }
        if (idle) report.checkpoint = yield* truncateWalWithBusyTimeout(connection, 0);
      }),
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        report.error = Cause.pretty(cause).slice(0, 500);
        return Effect.logWarning("database steady-state compaction step failed", {
          cause: report.error,
        });
      }),
    );
    return finish();
  }).pipe(Effect.withSpan("DatabaseCompaction.runSteadyStateStep"));
