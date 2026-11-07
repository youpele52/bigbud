import { Effect, Layer, FileSystem, Path } from "effect";
import { chmod } from "node:fs/promises";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import { UsageSqlClient } from "../Services/UsageSqlClient.ts";
import { ensureProjectionThreadsElevatorSummaryColumns } from "../Migrations/ProjectionThreadsElevatorSummary.columns.ts";
import { ServerConfig } from "../../startup/config.ts";
import { writeStartupProgress } from "../../startup/startupStatus.ts";
import { installTestProjectionThreadParentTriggers } from "./Sqlite.testParentThreads.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
  readonly readonly?: boolean;
  readonly spanAttributes?: Record<string, unknown>;
  /** Node only: run this connection in the SQLite worker thread. */
  readonly worker?: boolean;
};

type Loader = {
  layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient>;
};
const defaultSqliteClientLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  node: () => import("../NodeSqliteClient.ts"),
} satisfies Record<string, () => Promise<Loader>>;

const makeRuntimeSqliteLayer = Effect.fn("makeRuntimeSqliteLayer")(function* (
  config: RuntimeSqliteLayerConfig,
) {
  const runtime = process.versions.bun !== undefined ? "bun" : "node";
  const loader = defaultSqliteClientLoaders[runtime];
  const clientModule = yield* Effect.promise<Loader>(loader);
  return clientModule.layer(config);
}, Layer.unwrap);

interface SqlitePersistenceOptions {
  /** Report migration progress on the desktop startup status pipe (primary database only). */
  readonly reportStartupProgress?: boolean;
  /** Run the connection on the SQLite worker thread (default true). */
  readonly worker?: boolean;
}

const restrictDatabaseFiles = (dbPath: string) =>
  Effect.promise(async () => {
    await chmod(dbPath, 0o600);
    for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        await chmod(sidecar, 0o600);
      } catch (cause) {
        if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
      }
    }
  });

/** Connection settings, migrations and the persistent schema repairs that follow them. */
const migrateSchema = Effect.fn("migrateSchema")(function* (options: SqlitePersistenceOptions) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA journal_mode = WAL;`;
  yield* sql`PRAGMA foreign_keys = ON;`;
  yield* sql`PRAGMA busy_timeout = 5000;`;
  yield* runMigrations(options.reportStartupProgress ? { onProgress: writeStartupProgress } : {});
  yield* ensureProjectionThreadsElevatorSummaryColumns(sql);
  yield* installTestProjectionThreadParentTriggers();
});

/**
 * Node file databases run on the SQLite worker thread, so migrations, baseline
 * verification and runtime queries never block the event loop. Operational
 * statements share one connection; Usage has its own read-only worker, opened
 * after migrations. Bun development also isolates Usage in a worker.
 * `BIGBUD_SQLITE_WORKER=0` keeps Node connections in-process.
 */
export const makeSqlitePersistenceLive = Effect.fn("makeSqlitePersistenceLive")(function* (
  dbPath: string,
  options: SqlitePersistenceOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  const operational = Layer.provideMerge(
    Layer.effectDiscard(Effect.andThen(migrateSchema(options), restrictDatabaseFiles(dbPath))),
    makeRuntimeSqliteLayer({
      filename: dbPath,
      worker: options.worker ?? true,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "t3-server",
      },
    }),
  );

  // Depend on the migrated operational layer before opening the second connection.
  // Only publish its dedicated tag: never replace the operational SqlClient service.
  const usage = Layer.unwrap(
    Effect.as(Effect.service(SqlClient.SqlClient), makeUsageSqlitePersistenceLive(dbPath)),
  );
  return usage.pipe(Layer.provideMerge(operational));
}, Layer.unwrap);

const makeUsageSqlitePersistenceLive = (dbPath: string) =>
  Layer.effect(
    UsageSqlClient,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA query_only = ON`;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* sql`PRAGMA busy_timeout = 5000`;
      return sql;
    }),
  ).pipe(
    Layer.provide(
      process.versions.bun !== undefined
        ? Layer.unwrap(
            Effect.map(
              Effect.promise(() => import("../BunSqliteReadClient.ts")),
              (client) => client.layer({ filename: dbPath }),
            ),
          )
        : makeRuntimeSqliteLayer({ filename: dbPath, readonly: true, worker: true }),
    ),
  );

export const makeSqliteReadOnlyPersistenceLive = (dbPath: string) =>
  makeRuntimeSqliteLayer({ filename: dbPath, readonly: true });

export const SqlitePersistenceMemory = Layer.provideMerge(
  Layer.effectDiscard(migrateSchema({})),
  makeRuntimeSqliteLayer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), ({ dbPath }) =>
    makeSqlitePersistenceLive(dbPath, { reportStartupProgress: true }),
  ),
);
