import { Data, Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { latestMigrationId, migrationEntries } from "../../persistence/Migrations.ts";
import { PROJECTION_BASELINE_REQUIRED_TABLES } from "../../persistence/ProjectionBaselineSchema.ts";

export class ProjectionBaselineWorkspaceSchemaError extends Data.TaggedError(
  "ProjectionBaselineWorkspaceSchemaError",
)<{
  readonly workspaceId: string;
  readonly stage: string;
  readonly migrationId: number | null;
  readonly missingMigrations: ReadonlyArray<number>;
  readonly missingTables: ReadonlyArray<string>;
}> {
  override get message(): string {
    const migration = this.migrationId === null ? "none" : String(this.migrationId);
    const missingMigrations = this.missingMigrations.join(", ") || "none";
    const missingTables = this.missingTables.join(", ") || "none";
    return (
      `workspace ${this.workspaceId} schema validation failed at ${this.stage}; ` +
      `migration ${migration}/${latestMigrationId}; ` +
      `missing migrations [${missingMigrations}]; missing tables [${missingTables}]`
    );
  }
}

type MigrationRow = { readonly migrationId: number };
type TableRow = { readonly name: string };

/** Validates the schema contract needed before opening a baseline repository. */
export const validateProjectionBaselineWorkspace = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly workspaceId: string;
}) =>
  Effect.gen(function* () {
    const migrationRows = yield* input.sql<MigrationRow>`
      SELECT migration_id AS "migrationId"
      FROM effect_sql_migrations
      ORDER BY migration_id
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(
          new ProjectionBaselineWorkspaceSchemaError({
            workspaceId: input.workspaceId,
            stage: "migration ledger query",
            migrationId: null,
            missingMigrations: migrationEntries.map(([id]) => id),
            missingTables: [...PROJECTION_BASELINE_REQUIRED_TABLES],
          }),
        ).pipe(Effect.annotateLogs({ cause })),
      ),
    );
    const migrationIds = new Set(migrationRows.map((row) => row.migrationId));
    const migrationId = migrationRows.at(-1)?.migrationId ?? null;
    const missingMigrations = migrationEntries
      .map(([id]) => id)
      .filter((id) => !migrationIds.has(id));

    const tableRows = yield* input.sql<TableRow>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(
          new ProjectionBaselineWorkspaceSchemaError({
            workspaceId: input.workspaceId,
            stage: "schema table query",
            migrationId,
            missingMigrations,
            missingTables: [...PROJECTION_BASELINE_REQUIRED_TABLES],
          }),
        ).pipe(Effect.annotateLogs({ cause })),
      ),
    );
    const tableNames = new Set(tableRows.map((row) => row.name));
    const missingTables = PROJECTION_BASELINE_REQUIRED_TABLES.filter(
      (table) => !tableNames.has(table),
    );

    if (
      migrationId !== latestMigrationId ||
      missingMigrations.length > 0 ||
      missingTables.length > 0
    ) {
      return yield* new ProjectionBaselineWorkspaceSchemaError({
        workspaceId: input.workspaceId,
        stage: "migration/table validation",
        migrationId,
        missingMigrations,
        missingTables,
      });
    }

    return { migrationId, tableCount: tableNames.size };
  });
