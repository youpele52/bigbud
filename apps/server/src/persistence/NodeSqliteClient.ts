/**
 * Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
 * bindings instead of `better-sqlite3`.
 *
 * @module SqliteClient
 */
import { DatabaseSync } from "node:sqlite";

import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { makeSqliteClient } from "./SqliteClient.connection.ts";

import { openNodeSqliteDatabase } from "./NodeSqliteClient.files.ts";
import { makeInProcessConnection } from "./NodeSqliteClient.inProcess.ts";
import { makeWorkerConnection, resolveNodeSqliteWorkerEntry } from "./NodeSqliteClient.worker.ts";
import { exitProcessOnSqliteWorkerFailure } from "./NodeSqliteClient.worker.exit.ts";
import type { NodeSqliteWorkerBridgeFailure } from "./NodeSqliteClient.worker.bridge.ts";

export const TypeId: TypeId = "~local/sqlite-node/SqliteClient";

export type TypeId = "~local/sqlite-node/SqliteClient";

/**
 * SqliteClient - Effect service tag for the sqlite SQL client.
 */
export const SqliteClient = ServiceMap.Service<Client.SqlClient>("t3/persistence/NodeSqliteClient");

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
  /** Run the connection in a worker thread (default false); see `shouldUseWorker`. */
  readonly worker?: boolean | undefined;
  /**
   * Called once when an open worker crashes or exits on its own. The bridge never restarts,
   * so by default the process exits (`exitProcessOnSqliteWorkerFailure`) instead of serving
   * every later query a connection error while it looks alive.
   */
  readonly onWorkerFailure?: ((failure: NodeSqliteWorkerBridgeFailure) => void) | undefined;
}

export interface SqliteMemoryClientConfig extends Omit<
  SqliteClientConfig,
  "filename" | "readonly"
> {}

/**
 * Verify that the current Node.js version includes the `node:sqlite` APIs
 * used by `NodeSqliteClient` — specifically `StatementSync.columns()` (added
 * in Node 22.16.0 / 23.11.0).
 *
 * @see https://github.com/nodejs/node/pull/57490
 */
const checkNodeSqliteCompat = () => {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      `Node.js ${process.versions.node} is missing required node:sqlite APIs ` +
        `(StatementSync.columns). Upgrade to Node.js >=22.16, >=23.11, or >=24.`,
    );
  }
  return Effect.void;
};

/**
 * Worker selection: callers opt in with `worker: true`. `BIGBUD_SQLITE_WORKER=0`
 * forces every connection in-process and `all` forces every connection into a
 * worker (used to run test suites against the worker bridge).
 */
const shouldUseWorker = (options: SqliteClientConfig): boolean => {
  const mode = process.env.BIGBUD_SQLITE_WORKER?.trim().toLowerCase();
  if (mode === "0" || mode === "false") return false;
  if (mode === "all") return true;
  return options.worker ?? false;
};

const makeConnection = Effect.fn("makeConnection")(function* (
  options: SqliteClientConfig,
  openDatabase: () => DatabaseSync,
): Effect.fn.Return<Connection, never, Scope.Scope> {
  if (shouldUseWorker(options)) {
    const entry = resolveNodeSqliteWorkerEntry();
    if (entry) {
      return yield* makeWorkerConnection(
        entry,
        {
          filename: options.filename,
          readonly: options.readonly ?? false,
          allowExtension: options.allowExtension ?? false,
          prepareCacheSize: options.prepareCacheSize ?? 200,
        },
        undefined,
        { onUnexpectedFailure: options.onWorkerFailure ?? exitProcessOnSqliteWorkerFailure },
      );
    }
    yield* Effect.logWarning(
      "SQLite worker entry not found; running SQLite on the main thread instead.",
    );
  }
  return yield* makeInProcessConnection(options, openDatabase);
});

const makeWithDatabase = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
  openDatabase: () => DatabaseSync,
): Effect.fn.Return<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  return yield* makeSqliteClient(options, makeConnection(options, openDatabase));
});

const make = (
  options: SqliteClientConfig,
): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  makeWithDatabase(options, () =>
    openNodeSqliteDatabase(options.filename, {
      readonly: options.readonly ?? false,
      allowExtension: options.allowExtension ?? false,
    }),
  );

const makeMemory = (
  config: SqliteMemoryClientConfig = {},
): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  makeWithDatabase(
    {
      ...config,
      filename: ":memory:",
      readonly: false,
    },
    () => {
      const database = new DatabaseSync(":memory:", {
        allowExtension: config.allowExtension ?? false,
      });
      return database;
    },
  );

export const layerConfig = (
  config: Config.Wrap<SqliteClientConfig>,
): Layer.Layer<Client.SqlClient, Config.ConfigError> =>
  Layer.effectServices(
    Config.unwrap(config)
      .asEffect()
      .pipe(
        Effect.flatMap(make),
        Effect.map((client) =>
          ServiceMap.make(SqliteClient, client).pipe(ServiceMap.add(Client.SqlClient, client)),
        ),
      ),
  ).pipe(Layer.provide(Reactivity.layer));

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient> =>
  Layer.effectServices(
    Effect.map(make(config), (client) =>
      ServiceMap.make(SqliteClient, client).pipe(ServiceMap.add(Client.SqlClient, client)),
    ),
  ).pipe(Layer.provide(Reactivity.layer));

export const layerMemory = (config: SqliteMemoryClientConfig = {}): Layer.Layer<Client.SqlClient> =>
  Layer.effectServices(
    Effect.map(makeMemory(config), (client) =>
      ServiceMap.make(SqliteClient, client).pipe(ServiceMap.add(Client.SqlClient, client)),
    ),
  ).pipe(Layer.provide(Reactivity.layer));
