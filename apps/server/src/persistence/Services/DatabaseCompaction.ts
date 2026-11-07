/**
 * DatabaseCompaction - returns free database pages to the disk.
 *
 * - One-time rebuild: a confirmed Settings action sets `auto_vacuum = INCREMENTAL` and runs a
 *   full `VACUUM` on the write connection, once free pages are a large share of the file.
 * - Steady state: `runSteadyStateStep` is one short, bounded step (incremental vacuum, WAL
 *   truncate when idle, `journal_size_limit`) for the maintenance scheduler to call between
 *   batches.
 *
 * @module DatabaseCompaction
 */
import type {
  DatabaseCompactionPreview,
  DatabaseCompactionStatus,
  ServerDatabaseCompactionError,
} from "@bigbud/contracts/server/databaseCompaction.ts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface DatabaseSteadyStateStepInput {
  /**
   * The caller's view of load. When omitted, the step treats the database as idle only when
   * no statement is queued on the write worker and no turn is running.
   */
  readonly idle?: boolean;
}

export interface DatabaseSteadyStateStepReport {
  /** Set when the step did nothing at all, for example while a full compaction runs. */
  readonly skipped: "compaction-running" | null;
  /** `journal_size_limit` was applied to the write connection during this step. */
  readonly journalSizeLimitApplied: boolean;
  readonly autoVacuumIncremental: boolean;
  readonly freeFractionBefore: number;
  /** Pages released by `incremental_vacuum` (0 when it did not run). */
  readonly pagesReleased: number;
  /** Null when the WAL truncate did not run (not idle). */
  readonly checkpoint: {
    readonly busy: boolean;
    readonly logPages: number;
    readonly checkpointedPages: number;
  } | null;
  readonly elapsedMs: number;
  /** Set when a statement failed; the step stops there and the next one retries. */
  readonly error: string | null;
}

export interface DatabaseCompactionShape {
  /** Latest status, from memory; never touches the database. */
  readonly status: Effect.Effect<DatabaseCompactionStatus>;
  /** Sizes, free space and every precondition, read now. */
  readonly preview: Effect.Effect<DatabaseCompactionPreview, ServerDatabaseCompactionError>;
  /**
   * Rechecks every precondition, then starts the rebuild in the background and returns the
   * running status. Fails with the first blocker's code when one applies.
   */
  readonly start: Effect.Effect<DatabaseCompactionStatus, ServerDatabaseCompactionError>;
  /** One bounded steady-state step; never fails (problems are logged and reported). */
  readonly runSteadyStateStep: (
    input?: DatabaseSteadyStateStepInput,
  ) => Effect.Effect<DatabaseSteadyStateStepReport>;
}

export class DatabaseCompaction extends ServiceMap.Service<
  DatabaseCompaction,
  DatabaseCompactionShape
>()("bigbud/persistence/Services/DatabaseCompaction") {}
