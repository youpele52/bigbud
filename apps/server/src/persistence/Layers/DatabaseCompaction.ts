/**
 * DatabaseCompactionLive - the one-time rebuild behind Settings > Threads > "Compact database"
 * and the bounded steady-state step the maintenance scheduler calls between batches.
 *
 * - Preview and start read page counts, file sizes, free disk, running turns and the event-log
 *   maintenance backlog; `start` rechecks every precondition before it runs anything.
 * - The rebuild runs in the background on the write connection; `status` answers from memory,
 *   so the web can show its full-panel loader while every other statement waits.
 * - It counts as background SQL activity, so event-log maintenance skips its soft-load ticks
 *   meanwhile (its batches would only queue behind `VACUUM`).
 * - A marker file records a run in progress. A process that finds one at startup reports the
 *   run as completed, interrupted, or of unknown outcome (see `DatabaseCompaction.recovery`).
 * - Refused while SQLite runs in-process (Bun, `BIGBUD_SQLITE_WORKER=0`, missing worker entry):
 *   `VACUUM` would then block the backend's event loop for the whole rebuild.
 * - Whatever ends a run, the in-memory status returns to idle; a marker that cannot be removed
 *   is logged and reported on the run, never left to keep the status stuck on "running".
 *
 * @module DatabaseCompaction
 */
import type {
  DatabaseCompactionPhase,
  DatabaseCompactionPreview,
  DatabaseCompactionRun,
} from "@bigbud/contracts/server/databaseCompaction.ts";
import { ServerDatabaseCompactionError } from "@bigbud/contracts/server/databaseCompaction.ts";
import type { EventLogMaintenanceProgress } from "@bigbud/contracts/server/eventLogMaintenance.ts";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../startup/config.ts";
import { withBackgroundSqlActivity } from "../backgroundSqlActivity.ts";
import { nodeSqliteWriterQueueDepth } from "../NodeSqliteClient.worker.bridge.ts";
import {
  DatabaseCompaction,
  type DatabaseCompactionShape,
} from "../Services/DatabaseCompaction.ts";
import { EventLogMaintenance } from "../Services/EventLogMaintenance.ts";
import { detectSqliteExecution, type SqliteExecution } from "./DatabaseCompaction.execution.ts";
import {
  removeCompactionMarker,
  takeCompactionMarker,
  writeCompactionMarker,
} from "./DatabaseCompaction.marker.ts";
import {
  COMPACTION_BLOCKER_MESSAGES,
  type CompactionThresholds,
  compactionBlockers,
  DEFAULT_COMPACTION_THRESHOLDS,
  estimateCompactionDurationMs,
  expectedBytesAfterCompaction,
  freeFraction,
  isCompactionOffered,
  type TempDiskSpace,
} from "./DatabaseCompaction.policy.ts";
import { describeCause, recoverRun, toIso } from "./DatabaseCompaction.recovery.ts";
import {
  readDiskFreeBytes,
  readFileSizes,
  readTempDiskSpace,
  readPageStats,
  readRunningTurns,
} from "./DatabaseCompaction.stats.ts";
import {
  applyJournalSizeLimit,
  runSteadyStateStep,
  type SteadyStateMemory,
} from "./DatabaseCompaction.steadyState.ts";
import {
  type RebuildResult,
  runIncrementalRebuild,
  truncateWalAfterFailure,
} from "./DatabaseCompaction.vacuum.ts";

export interface DatabaseCompactionOptions {
  readonly dbPath: string;
  readonly thresholds?: CompactionThresholds;
  readonly now?: () => number;
  readonly clock?: () => number;
  /** Replaces the free-disk reading (tests). */
  readonly readDiskFreeBytes?: (dbPath: string) => Effect.Effect<number | null>;
  /** Replaces the temp-directory free-space reading (tests). */
  readonly readTempDiskSpace?: (dbPath: string) => Effect.Effect<TempDiskSpace>;
  /** Replaces the live event-log maintenance progress (tests). */
  readonly maintenanceProgress?: Effect.Effect<EventLogMaintenanceProgress | null>;
  /** Where the write connection runs; detected from the runtime when omitted. */
  readonly sqliteExecution?: SqliteExecution;
  /** Replaces the rebuild statements (tests). */
  readonly rebuild?: typeof runIncrementalRebuild;
  /** Replaces the marker removal (tests). */
  readonly removeMarker?: typeof removeCompactionMarker;
}

interface RunningCompaction {
  readonly startedAtMs: number;
  phase: DatabaseCompactionPhase;
  estimatedDurationMs: number | null;
}

const compactionError = (code: ServerDatabaseCompactionError["code"], message: string) =>
  new ServerDatabaseCompactionError({ code, message });

export const makeDatabaseCompaction = Effect.fn("makeDatabaseCompaction")(function* (
  options: DatabaseCompactionOptions,
) {
  const sql = yield* SqlClient.SqlClient;
  const maintenance = yield* Effect.serviceOption(EventLogMaintenance);
  const { dbPath } = options;
  const thresholds = options.thresholds ?? DEFAULT_COMPACTION_THRESHOLDS;
  const now = options.now ?? (() => Date.now());
  const clock = options.clock ?? (() => performance.now());
  const diskFree = options.readDiskFreeBytes ?? readDiskFreeBytes;
  const tempDiskSpace = options.readTempDiskSpace ?? readTempDiskSpace;
  const maintenanceProgress =
    options.maintenanceProgress ??
    (Option.isSome(maintenance) ? maintenance.value.progress : Effect.succeed(null));
  const sqliteExecution = options.sqliteExecution ?? detectSqliteExecution();
  const rebuildStatements = options.rebuild ?? runIncrementalRebuild;
  const removeMarker = options.removeMarker ?? removeCompactionMarker;

  let running: RunningCompaction | null = null;
  const marker = yield* takeCompactionMarker(dbPath);
  let lastRun: DatabaseCompactionRun | null = marker
    ? yield* recoverRun(sql, dbPath, marker, now())
    : null;

  const steadyMemory: SteadyStateMemory = { journalSizeLimitApplied: false };
  yield* Effect.scoped(Effect.flatMap(sql.reserve, applyJournalSizeLimit)).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        steadyMemory.journalSizeLimitApplied = true;
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("could not set journal_size_limit; the steady-state step retries", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const status: DatabaseCompactionShape["status"] = Effect.sync(() => ({
    state: running ? "running" : "idle",
    phase: running?.phase ?? null,
    startedAt: running ? toIso(running.startedAtMs) : null,
    estimatedDurationMs: running?.estimatedDurationMs ?? null,
    lastRun,
  }));

  const gather = (isRunning: boolean) =>
    Effect.gen(function* () {
      const stats = yield* readPageStats(sql);
      const sizes = yield* readFileSizes(dbPath);
      const diskFreeBytes = yield* diskFree(dbPath);
      const tempDisk = yield* tempDiskSpace(dbPath);
      const runningTurns = yield* readRunningTurns(sql);
      const progress = yield* maintenanceProgress;
      const expectedBytes = expectedBytesAfterCompaction(stats);
      const blockers = compactionBlockers(
        {
          stats,
          ...sizes,
          diskFreeBytes,
          tempDisk,
          runningTurns,
          running: isRunning,
          inProcessSqlite: sqliteExecution === "in-process",
          maintenance: progress
            ? {
                backlogSequences: progress.backlogSequences,
                disabled: progress.state === "disabled",
                starved: progress.starved,
              }
            : null,
        },
        thresholds,
      );
      return {
        generatedAt: toIso(now()),
        fileBytes: sizes.fileBytes,
        walBytes: sizes.walBytes,
        pageSize: stats.pageSize,
        pageCount: stats.pageCount,
        freelistCount: stats.freelistCount,
        freeBytes: stats.freelistCount * stats.pageSize,
        freeFraction: freeFraction(stats),
        expectedBytes,
        autoVacuum: stats.autoVacuum,
        diskFreeBytes,
        requiredDiskBytes: sizes.fileBytes + sizes.walBytes,
        runningTurns: Math.min(runningTurns, 1_000_000),
        maintenanceBacklog: progress?.backlogSequences ?? 0,
        estimatedDurationMs: estimateCompactionDurationMs(sizes.fileBytes, expectedBytes),
        offered: isCompactionOffered(stats, thresholds),
        blockers,
      } satisfies DatabaseCompactionPreview;
    }).pipe(
      Effect.mapError((error) =>
        compactionError("failed", `Could not read the database size: ${error.message}`.trim()),
      ),
    );

  const alreadyRunning = Effect.fail(
    compactionError("already-running", COMPACTION_BLOCKER_MESSAGES["already-running"]),
  );

  const preview: DatabaseCompactionShape["preview"] = Effect.suspend(() =>
    running ? alreadyRunning : gather(false),
  );

  /**
   * Publishes the run first, so the status is idle even when the marker cannot be removed; that
   * failure is logged and noted on the run (the next start would report the run again).
   */
  const finishRun = (claim: RunningCompaction, run: DatabaseCompactionRun) =>
    Effect.gen(function* () {
      if (running === claim) running = null;
      lastRun = run;
      const removed = yield* Effect.exit(removeMarker(dbPath));
      if (Exit.isSuccess(removed)) return;
      const markerError = describeCause(removed.cause);
      yield* Effect.logWarning("could not remove the database compaction marker", {
        error: markerError,
      });
      if (lastRun === run) {
        lastRun = {
          ...run,
          error: [run.error, `${markerError}. bigbud may report this run again after a restart.`]
            .filter((part) => part !== null)
            .join(" ")
            .slice(0, 1_000),
        };
      }
    });

  const succeeded = (claim: RunningCompaction, bytesBefore: number, result: RebuildResult) =>
    Effect.gen(function* () {
      const sizes = yield* readFileSizes(dbPath);
      yield* finishRun(claim, {
        outcome: "completed",
        startedAt: toIso(claim.startedAtMs),
        finishedAt: toIso(now()),
        bytesBefore,
        bytesAfter: sizes.fileBytes,
        checkpointComplete: !result.checkpoint.busy,
        error: null,
      });
      yield* Effect.logInfo("database compaction completed", {
        bytesBefore,
        bytesAfter: sizes.fileBytes,
        autoVacuum: result.autoVacuum,
        walCheckpointBusy: result.checkpoint.busy,
      });
    });

  const failed = (claim: RunningCompaction, bytesBefore: number, cause: Cause.Cause<unknown>) =>
    Effect.gen(function* () {
      const error = describeCause(cause);
      // A VACUUM that died on a full disk can leave a multi-gigabyte WAL; shrink it now.
      const checkpoint = yield* truncateWalAfterFailure(sql);
      yield* finishRun(claim, {
        outcome: "failed",
        startedAt: toIso(claim.startedAtMs),
        finishedAt: toIso(now()),
        bytesBefore,
        bytesAfter: null,
        checkpointComplete: checkpoint !== null && !checkpoint.busy,
        error,
      });
      yield* Effect.logWarning("database compaction failed; the database was not changed", {
        error,
        walTruncated: checkpoint !== null && !checkpoint.busy,
      });
    });

  const rebuild = (claim: RunningCompaction, bytesBefore: number) =>
    withBackgroundSqlActivity(
      rebuildStatements(sql, (phase) => {
        if (running === claim) claim.phase = phase;
      }).pipe(
        Effect.matchCauseEffect({
          onSuccess: (result) => succeeded(claim, bytesBefore, result),
          // Shutdown: the worker may still finish the statement, so the marker stays for the
          // next process to settle.
          onFailure: (cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : failed(claim, bytesBefore, cause),
        }),
      ),
    ).pipe(
      // However the run ends (including a defect while reporting it), the status leaves
      // "running", so maintenance resumes and the loader closes.
      Effect.ensuring(
        Effect.sync(() => {
          if (running === claim) running = null;
        }),
      ),
    );

  const scope = yield* Effect.scope;
  const start: DatabaseCompactionShape["start"] = Effect.suspend(() => {
    if (running) return alreadyRunning;
    const claim: RunningCompaction = {
      startedAtMs: now(),
      phase: "preparing",
      estimatedDurationMs: null,
    };
    running = claim;
    // Set once the rebuild fiber owns the claim and the marker; from then on only it clears them.
    let handedOff = false;
    const release = Effect.suspend(() => {
      if (handedOff) return Effect.void;
      if (running === claim) running = null;
      return Effect.void;
    });
    return Effect.gen(function* () {
      const checked = yield* gather(false);
      const blocker = checked.blockers[0];
      if (blocker !== undefined)
        return yield* compactionError(blocker, COMPACTION_BLOCKER_MESSAGES[blocker]);
      claim.estimatedDurationMs = checked.estimatedDurationMs;
      // Uninterruptible from the marker write to the fork: an interrupt can neither leave a
      // marker for a run that never started nor release the claim while VACUUM runs.
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* writeCompactionMarker(dbPath, {
            startedAt: toIso(claim.startedAtMs),
            bytesBefore: checked.fileBytes,
            autoVacuumBefore: checked.autoVacuum,
          }).pipe(
            // A partial write must not survive to be reported as an interrupted run.
            Effect.tapError(() => Effect.ignore(removeMarker(dbPath))),
          );
          yield* Effect.logInfo("database compaction starting", {
            fileBytes: checked.fileBytes,
            expectedBytes: checked.expectedBytes,
            freeFraction: checked.freeFraction,
          });
          yield* Effect.forkIn(rebuild(claim, checked.fileBytes), scope);
          handedOff = true;
        }),
      );
      return yield* status;
    }).pipe(Effect.onError(() => release));
  });

  const defaultIdle = Effect.map(
    readRunningTurns(sql),
    (turns) => turns === 0 && nodeSqliteWriterQueueDepth() === 0,
  );

  return {
    status,
    preview,
    start,
    runSteadyStateStep: (input) =>
      runSteadyStateStep(
        {
          sql,
          memory: steadyMemory,
          compactionRunning: () => running !== null,
          defaultIdle,
          clock,
        },
        input,
      ),
  } satisfies DatabaseCompactionShape;
});

export const DatabaseCompactionLive = Layer.effect(
  DatabaseCompaction,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return yield* makeDatabaseCompaction({ dbPath: config.dbPath });
  }),
);
