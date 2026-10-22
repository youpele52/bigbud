/**
 * Main-thread side of the `node:sqlite` worker bridge. Every statement is a
 * request/response round trip to the single worker-owned connection, so the
 * event loop is never blocked by query execution.
 *
 * Bridge failures (crash, exit, failed or timed-out open) surface as a
 * `ConnectionError`; failed statements keep their SQLite classification.
 *
 * @module NodeSqliteClient.worker
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import * as Stream from "effect/Stream";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { ConnectionError, SqlError, classifySqliteError } from "effect/unstable/sql/SqlError";

import {
  DEFAULT_NODE_SQLITE_WORKER_TIMEOUTS,
  NodeSqliteWorkerBridge,
  type NodeSqliteWorkerBridgeTimeouts,
  type NodeSqliteWorkerResult,
} from "./NodeSqliteClient.worker.bridge.ts";
import {
  deserializeWorkerError,
  type NodeSqliteWorkerExecuteMode,
  type NodeSqliteWorkerOpenOptions,
} from "./NodeSqliteWorker.protocol.ts";

/** Bundled entry name (see `tsdown.config.ts`) and the source entry used under tests. */
const WORKER_ENTRY_CANDIDATES = ["NodeSqliteWorker.mjs", "NodeSqliteWorker.ts"] as const;

/** Resolves the worker entry beside this module, or `undefined` when it is not shipped. */
export function resolveNodeSqliteWorkerEntry(): string | undefined {
  const directory = dirname(fileURLToPath(import.meta.url));
  for (const name of WORKER_ENTRY_CANDIDATES) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const connectionError = (message: string, cause: unknown) =>
  new SqlError({ reason: new ConnectionError({ cause, message, operation: "execute" }) });

function toSqlError(response: Extract<NodeSqliteWorkerResult, { ok: false }>): SqlError {
  const cause = deserializeWorkerError(response.error);
  return new SqlError({
    reason: classifySqliteError(cause, {
      message:
        response.phase === "prepare"
          ? "Failed to prepare statement"
          : "Failed to execute statement",
      operation: response.phase,
    }),
  });
}

/**
 * Starts the worker, waits (bounded) for the database to open, and returns a
 * `Connection` whose finalizer closes the database and waits for the thread to
 * exit. See `NodeSqliteClient.worker.bridge.ts` for the full bridge contract,
 * including that an interrupted caller does not cancel its running statement.
 */
export const makeWorkerConnection = Effect.fn("makeWorkerConnection")(function* (
  entry: string,
  options: NodeSqliteWorkerOpenOptions,
  timeouts: NodeSqliteWorkerBridgeTimeouts = DEFAULT_NODE_SQLITE_WORKER_TIMEOUTS,
): Effect.fn.Return<Connection, never, Scope.Scope> {
  const bridge = new NodeSqliteWorkerBridge(entry, options, timeouts);
  const bridgeError = () => {
    const failure = bridge.failure;
    return failure ? connectionError(failure.message, failure.cause) : undefined;
  };

  yield* Effect.tryPromise({
    try: () => bridge.open(),
    catch: (cause) =>
      connectionError(cause instanceof Error ? cause.message : String(cause), cause),
  }).pipe(Effect.orDie);
  yield* Effect.addFinalizer(() => Effect.promise(() => bridge.close()));

  const run = (
    sql: string,
    params: ReadonlyArray<unknown>,
    mode: NodeSqliteWorkerExecuteMode,
  ): Effect.Effect<ReadonlyArray<any>, SqlError> =>
    Effect.withFiber((fiber) => {
      const safeIntegers = Boolean(ServiceMap.get(fiber.services, Client.SafeIntegers));
      return Effect.callback<ReadonlyArray<any>, SqlError>((resume) => {
        bridge.execute({ kind: "execute", sql, params, mode, safeIntegers }, (response) => {
          if (response.ok) return resume(Effect.succeed(response.rows));
          resume(Effect.fail(bridgeError() ?? toSqlError(response)));
        });
      });
    });

  return {
    execute(sql, params, rowTransform) {
      const effect = run(sql, params, "rows");
      return rowTransform ? Effect.map(effect, rowTransform) : effect;
    },
    executeRaw(sql, params) {
      return run(sql, params, "raw");
    },
    executeValues(sql, params) {
      return run(sql, params, "values") as Effect.Effect<
        ReadonlyArray<ReadonlyArray<unknown>>,
        SqlError
      >;
    },
    executeUnprepared(sql, params, rowTransform) {
      const effect = run(sql, params ?? [], "unprepared");
      return rowTransform ? Effect.map(effect, rowTransform) : effect;
    },
    executeStream(_sql, _params) {
      return Stream.die("executeStream not implemented");
    },
  } satisfies Connection;
});
