/**
 * Newer-schema startup refusal. The Effect migrator only runs migrations above
 * the highest applied id, so an older runtime would silently open a database
 * whose schema a newer runtime already changed. This guard refuses that
 * startup before any migration or query runs. It applies to every mode (local
 * and remote) because all of them migrate through `runMigrations`.
 *
 * @module MigrationsDowngradeGuard
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { readLatestAppliedMigrationId } from "./MigrationProgress.ts";

export class DatabaseSchemaNewerThanRuntimeError extends Schema.TaggedErrorClass<DatabaseSchemaNewerThanRuntimeError>()(
  "DatabaseSchemaNewerThanRuntimeError",
  {
    appliedMigrationId: Schema.Number,
    appliedMigrationName: Schema.String,
    latestKnownMigrationId: Schema.Number,
  },
) {
  override get message(): string {
    return (
      `The database schema is newer than this bigbud build: migration ` +
      `${this.appliedMigrationId}_${this.appliedMigrationName} is applied, but this build only ` +
      `knows migrations up to ${this.latestKnownMigrationId}. Startup is refused so an older ` +
      `runtime never uses a newer schema. Run a build that includes migration ` +
      `${this.appliedMigrationId}, or restore a database backup made by this version.`
    );
  }
}

/** Fails when the highest applied migration id is above `latestKnownMigrationId`. */
export const assertDatabaseSchemaNotNewer = Effect.fn("assertDatabaseSchemaNotNewer")(function* (
  latestKnownMigrationId: number,
) {
  const appliedMigrationId = yield* readLatestAppliedMigrationId();
  if (appliedMigrationId <= latestKnownMigrationId) return appliedMigrationId;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string | null }>`
    SELECT name FROM effect_sql_migrations WHERE migration_id = ${appliedMigrationId}
  `;
  return yield* new DatabaseSchemaNewerThanRuntimeError({
    appliedMigrationId,
    appliedMigrationName: rows[0]?.name ?? "unknown",
    latestKnownMigrationId,
  });
});
