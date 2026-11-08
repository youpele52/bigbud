import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as ServiceMap from "effect/ServiceMap";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import * as Statement from "effect/unstable/sql/Statement";

interface SqliteClientOptions {
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
}

/** Shared transaction ownership and statement compilation for both worker runtimes. */
export const makeSqliteClient = Effect.fn("makeSqliteClient")(function* (
  options: SqliteClientOptions,
  acquireConnection: Effect.Effect<Connection, never, Scope.Scope>,
): Effect.fn.Return<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> {
  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  const semaphore = yield* Semaphore.make(1);
  const connection = yield* acquireConnection;
  const acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
  const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
    const fiber = Fiber.getCurrent()!;
    const scope = ServiceMap.getUnsafe(fiber.services, Scope.Scope);
    return Effect.as(
      Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))),
      connection,
    );
  });

  return yield* Client.make({
    acquirer,
    compiler,
    transactionAcquirer,
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      ["db.system.name", "sqlite"],
    ],
    transformRows,
  });
});
