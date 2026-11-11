import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { makeLegacyMetadataAdmission } from "./ThreadMetadataGeneration.legacy.admission.ts";
import { seedThread } from "./ThreadMetadataGeneration.legacy.test-helpers.ts";
import { withMetadataTransaction } from "./ThreadMetadataGeneration.transaction.ts";

it.layer(SqlitePersistenceMemory)("metadata transaction ownership", (it) => {
  it.effect("commits success and rolls back failure before releasing the connection", () =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("metadata-transaction-outcomes");
      const sql = yield* SqlClient.SqlClient;
      yield* withMetadataTransaction(
        sql,
        sql`UPDATE projection_threads SET title = 'Committed' WHERE thread_id = ${threadId}`,
      );
      const result = yield* withMetadataTransaction(
        sql,
        sql`UPDATE projection_threads SET title = 'Rolled back' WHERE thread_id = ${threadId}`.pipe(
          Effect.andThen(Effect.fail("expected failure")),
        ),
      ).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.deepStrictEqual(
        yield* sql`SELECT title FROM projection_threads WHERE thread_id = ${threadId}`,
        [{ title: "Committed" }],
      );
    }),
  );

  it.effect("reuses an enclosing transaction and keeps its rollback authoritative", () =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("metadata-transaction-nested");
      const sql = yield* SqlClient.SqlClient;
      const admit = yield* makeLegacyMetadataAdmission();
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            assert.isTrue((yield* admit({ threadId, operation: "title" })).allowed);
            yield* withMetadataTransaction(
              sql,
              sql`UPDATE projection_threads SET title = 'Nested' WHERE thread_id = ${threadId}`,
            );
            return yield* Effect.fail("outer rollback");
          }),
        )
        .pipe(Effect.result);
      assert.deepStrictEqual(
        yield* sql`SELECT title FROM projection_threads WHERE thread_id = ${threadId}`,
        [{ title: "Legacy" }],
      );
    }),
  );

  it.effect(
    "interruption rolls back writes and releases the reservation without detached work",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const threadId = yield* seedThread("metadata-transaction-interrupted");
          const sql = yield* SqlClient.SqlClient;
          const written = yield* Deferred.make<void>();
          const transaction = yield* withMetadataTransaction(
            sql,
            Effect.gen(function* () {
              yield* sql`UPDATE projection_threads SET title = 'Interrupted' WHERE thread_id = ${threadId}`;
              yield* Deferred.succeed(written, undefined);
              return yield* Effect.never;
            }),
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(written);
          yield* Fiber.interrupt(transaction);
          assert.deepStrictEqual(
            yield* sql`SELECT title FROM projection_threads WHERE thread_id = ${threadId}`,
            [{ title: "Legacy" }],
          );
          yield* withMetadataTransaction(sql, Effect.void);
        }),
      ),
  );
});
