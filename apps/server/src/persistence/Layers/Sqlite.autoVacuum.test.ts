import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { withDatabase } from "./DatabaseCompaction.test.helpers.ts";
import { execute } from "./DatabaseCompaction.vacuum.ts";
import { enableIncrementalAutoVacuumOnFreshDatabase } from "./Sqlite.autoVacuum.ts";

const pragma = (name: string) =>
  Effect.flatMap(SqlClient.SqlClient.asEffect(), (sql) =>
    sql.unsafe<Record<string, number>>(`PRAGMA ${name}`),
  ).pipe(Effect.map((rows) => Number(Object.values(rows[0] ?? {})[0] ?? 0)));

const fillAndDelete = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE filler (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`;
  for (let index = 0; index < 400; index += 1) {
    yield* sql`INSERT INTO filler (body) VALUES (${"x".repeat(4_000)})`;
  }
  yield* sql`DELETE FROM filler`;
});

it.live("a fresh database reclaims freed pages without a rebuild", () =>
  withDatabase("autovacuum-fresh", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* enableIncrementalAutoVacuumOnFreshDatabase());
      yield* fillAndDelete;
      assert.strictEqual(yield* pragma("auto_vacuum"), 2);
      const freeBefore = yield* pragma("freelist_count");
      assert.isAbove(freeBefore, 300);
      const sql = yield* SqlClient.SqlClient;
      // The steady-state step's bounded release, run the way that step runs it.
      yield* Effect.scoped(
        Effect.flatMap(sql.reserve, (connection) =>
          execute(connection, "PRAGMA incremental_vacuum(1024)"),
        ),
      );
      assert.strictEqual(yield* pragma("freelist_count"), 0);
    }),
  ),
);

it.live("an existing database keeps its mode (the rebuild stays user-confirmed)", () =>
  withDatabase("autovacuum-existing", () =>
    Effect.gen(function* () {
      yield* fillAndDelete;
      assert.isFalse(yield* enableIncrementalAutoVacuumOnFreshDatabase());
      assert.strictEqual(yield* pragma("auto_vacuum"), 0);
    }),
  ),
);
