/**
 * In-process `node:sqlite` connection. Every statement runs on the calling
 * thread. Used for in-memory databases and as the opt-out fallback
 * (`BIGBUD_SQLITE_WORKER=0`) for the worker-backed connection.
 *
 * @module NodeSqliteClient.inProcess
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";

import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Scope from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import * as Stream from "effect/Stream";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/unstable/sql/SqlError";

export interface InProcessConnectionOptions {
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
}

export const makeInProcessConnection = Effect.fn("makeInProcessConnection")(function* (
  options: InProcessConnectionOptions,
  openDatabase: () => DatabaseSync,
): Effect.fn.Return<Connection, never, Scope.Scope> {
  const scope = yield* Effect.scope;
  const db = openDatabase();
  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => db.close()),
  );

  const statementReaderCache = new WeakMap<StatementSync, boolean>();
  const hasRows = (statement: StatementSync): boolean => {
    const cached = statementReaderCache.get(statement);
    if (cached !== undefined) {
      return cached;
    }
    const value = statement.columns().length > 0;
    statementReaderCache.set(statement, value);
    return value;
  };

  const prepareCache = yield* Cache.make({
    capacity: options.prepareCacheSize ?? 200,
    timeToLive: options.prepareCacheTTL ?? Duration.minutes(10),
    lookup: (sql: string) =>
      Effect.try({
        try: () => db.prepare(sql),
        catch: (cause) =>
          new SqlError({
            reason: classifySqliteError(cause, {
              message: "Failed to prepare statement",
              operation: "prepare",
            }),
          }),
      }),
  });

  const runStatement = (statement: StatementSync, params: ReadonlyArray<unknown>, raw: boolean) =>
    Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
      statement.setReadBigInts(Boolean(ServiceMap.get(fiber.services, Client.SafeIntegers)));
      try {
        if (hasRows(statement)) {
          return Effect.succeed(statement.all(...(params as any)));
        }
        const result = statement.run(...(params as any));
        return Effect.succeed(raw ? (result as unknown as ReadonlyArray<any>) : []);
      } catch (cause) {
        return Effect.fail(
          new SqlError({
            reason: classifySqliteError(cause, {
              message: "Failed to execute statement",
              operation: "execute",
            }),
          }),
        );
      }
    });

  const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
    Effect.flatMap(Cache.get(prepareCache, sql), (s) => runStatement(s, params, raw));

  const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
    Effect.acquireUseRelease(
      Cache.get(prepareCache, sql),
      (statement) =>
        Effect.try({
          try: () => {
            if (hasRows(statement)) {
              statement.setReturnArrays(true);
              // Safe to cast to array after we've setReturnArrays(true)
              return statement.all(...(params as any)) as unknown as ReadonlyArray<
                ReadonlyArray<unknown>
              >;
            }
            statement.run(...(params as any));
            return [];
          },
          catch: (cause) =>
            new SqlError({
              reason: classifySqliteError(cause, {
                message: "Failed to execute statement",
                operation: "execute",
              }),
            }),
        }),
      (statement) =>
        Effect.sync(() => {
          if (hasRows(statement)) {
            statement.setReturnArrays(false);
          }
        }),
    );

  return identity<Connection>({
    execute(sql, params, rowTransform) {
      return rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
    },
    executeRaw(sql, params) {
      return run(sql, params, true);
    },
    executeValues(sql, params) {
      return runValues(sql, params);
    },
    executeUnprepared(sql, params, rowTransform) {
      const effect = runStatement(db.prepare(sql), params ?? [], false);
      return rowTransform ? Effect.map(effect, rowTransform) : effect;
    },
    executeStream(_sql, _params) {
      return Stream.die("executeStream not implemented");
    },
  });
});
