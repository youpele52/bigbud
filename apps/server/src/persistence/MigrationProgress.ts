/**
 * Progress reporting for long migrations. `runMigrations` provides a
 * per-migration reporter; chunked migrations call it with the fraction of
 * their own work that is done. Without a reporter the calls are no-ops.
 *
 * @module MigrationProgress
 */
import * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Reports the fraction (0 to 1) of the running migration that is complete. */
export type MigrationStepProgressReporter = (fraction: number) => Effect.Effect<void>;

export const MigrationStepProgress = ServiceMap.Reference<MigrationStepProgressReporter>(
  "bigbud/persistence/MigrationStepProgress",
  { defaultValue: () => () => Effect.void },
);

/** Receives whole-run progress as an integer percent, only when it changes. */
export type MigrationProgressListener = (percent: number) => void;

const MIGRATIONS_TABLE = "effect_sql_migrations";

/** Highest applied migration id, or 0 for a database that has never been migrated. */
export const readLatestAppliedMigrationId = Effect.fn("readLatestAppliedMigrationId")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${MIGRATIONS_TABLE}
    `;
  if (tables.length === 0) return 0;
  const rows = yield* sql<{ readonly id: number | null }>`
      SELECT MAX(migration_id) AS "id" FROM effect_sql_migrations
    `;
  return rows[0]?.id ?? 0;
});

/**
 * Tracks progress across `total` pending migrations. Each migration counts as
 * one equal step; a chunked migration fills its step as it reports fractions.
 */
export function makeMigrationProgressTracker(total: number, listener: MigrationProgressListener) {
  let lastPercent = -1;
  const emit = (completedSteps: number) => {
    const percent = Math.max(0, Math.min(100, Math.floor((completedSteps / total) * 100)));
    if (percent === lastPercent) return;
    lastPercent = percent;
    listener(percent);
  };
  return {
    start: () => emit(0),
    /** Wraps the migration at `index` (0-based among pending migrations). */
    wrap: <A, E, R>(index: number, migration: Effect.Effect<A, E, R>) =>
      migration.pipe(
        Effect.provideService(MigrationStepProgress, (fraction) =>
          Effect.sync(() => emit(index + Math.max(0, Math.min(1, fraction)))),
        ),
        Effect.tap(() => Effect.sync(() => emit(index + 1))),
      ),
  };
}
