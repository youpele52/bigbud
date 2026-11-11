import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Reserve interruptibly before entering Effect SQL's masked transaction lifecycle.
 * An outer deadline can then cancel queue waiting without detaching an acquisition
 * fiber. Existing transactions retain their connection and nested savepoint semantics.
 */
export const withMetadataTransaction = Effect.fn("withMetadataTransaction")(function* <A, E, R>(
  sql: SqlClient.SqlClient,
  effect: Effect.Effect<A, E, R>,
) {
  const existing = yield* Effect.serviceOption(SqlClient.TransactionConnection);
  if (Option.isSome(existing)) return yield* sql.withTransaction(effect);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* sql.reserve;
      const execute = (statement: string) => connection.executeUnprepared(statement, [], undefined);
      const withTransaction = SqlClient.makeWithTransaction({
        transactionService: SqlClient.TransactionConnection,
        spanAttributes: [["db.system.name", "sqlite"]],
        acquireConnection: Effect.succeed([undefined, connection] as const),
        begin: () => execute("BEGIN"),
        commit: () => execute("COMMIT"),
        rollback: () => execute("ROLLBACK"),
        savepoint: (_, id) => execute(`SAVEPOINT effect_sql_${id}`),
        rollbackSavepoint: (_, id) => execute(`ROLLBACK TO SAVEPOINT effect_sql_${id}`),
      });
      return yield* withTransaction(effect);
    }),
  );
});
