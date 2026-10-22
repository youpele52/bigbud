import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterAll } from "vitest";

import * as SqliteClient from "./NodeSqliteClient.ts";
import { makeWorkerConnection, resolveNodeSqliteWorkerEntry } from "./NodeSqliteClient.worker.ts";

const directory = mkdtempSync(join(tmpdir(), "bigbud-sqlite-worker-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

// `it.effect` runs on the TestClock; the bridge test needs real elapsed time between statements.
const realSleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const layer = it.layer(
  Layer.fresh(SqliteClient.layer({ filename: join(directory, "bridge.sqlite"), worker: true })),
);

layer("NodeSqliteClient worker bridge", (it) => {
  it.effect("runs prepared, raw, values and unprepared statements", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL, data BLOB)`;
      yield* sql`INSERT INTO entries(name, data) VALUES (${"alpha"}, ${new Uint8Array([1, 2])})`;
      yield* sql`INSERT INTO entries(name) VALUES (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
        SELECT id, name FROM entries ORDER BY id
      `;
      assert.deepEqual(
        rows.map((row) => row.name),
        ["alpha", "beta"],
      );
      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.deepEqual(values, [
        [1, "alpha"],
        [2, "beta"],
      ]);
      const blob = yield* sql<{ readonly data: Uint8Array }>`SELECT data FROM entries WHERE id = 1`;
      assert.deepEqual([...(blob[0]?.data ?? [])], [1, 2]);
      const raw = yield* sql`UPDATE entries SET name = 'gamma' WHERE id = 2`.raw;
      assert.equal((raw as unknown as { readonly changes: number }).changes, 1);
      const mode = yield* sql<{ readonly journal_mode: string }>`PRAGMA journal_mode`;
      assert.equal(mode[0]?.journal_mode, "wal");
    }),
  );

  it.effect("surfaces SQLite failures as classified SqlErrors", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE unique_names(name TEXT PRIMARY KEY)`;
      yield* sql`INSERT INTO unique_names VALUES ('a')`;
      const duplicate = yield* Effect.exit(sql`INSERT INTO unique_names VALUES ('a')`);
      assert.isTrue(Exit.isFailure(duplicate));
      const syntax = yield* Effect.flip(sql.unsafe("SELEC nonsense"));
      assert.equal(syntax._tag, "SqlError");
      assert.match(String(syntax.reason.message), /prepare/i);
    }),
  );

  it.effect("rolls back a failed nested transaction to its savepoint only", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE nested(label TEXT NOT NULL)`;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO nested VALUES ('outer-before')`;
          const inner = yield* Effect.exit(
            sql.withTransaction(
              Effect.andThen(
                sql`INSERT INTO nested VALUES ('inner')`,
                Effect.fail("undo" as const),
              ),
            ),
          );
          assert.isTrue(Exit.isFailure(inner));
          yield* sql.withTransaction(sql`INSERT INTO nested VALUES ('inner-kept')`);
          yield* sql`INSERT INTO nested VALUES ('outer-after')`;
        }),
      );
      const rows = yield* sql<{ readonly label: string }>`SELECT label FROM nested ORDER BY rowid`;
      assert.deepEqual(
        rows.map((row) => row.label),
        ["outer-before", "inner-kept", "outer-after"],
      );
    }),
  );

  it.effect("returns BigInt values when safe integers are requested", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const big = 9_007_199_254_740_993n;
      const safe = yield* sql<{ readonly value: bigint }>`SELECT ${big} AS value`.pipe(
        Effect.provideService(SqlClient.SafeIntegers, true),
      );
      assert.strictEqual(safe[0]?.value, big);
      const plain = yield* sql<{ readonly value: number }>`SELECT 42 AS value`;
      assert.strictEqual(plain[0]?.value, 42);
    }),
  );

  it.effect("keeps a transaction free of statements from other callers", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE ledger(id INTEGER PRIMARY KEY, writer TEXT NOT NULL)`;
      const transaction = yield* Effect.forkChild(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO ledger(writer) VALUES ('tx')`;
            yield* realSleep(20);
            yield* sql`INSERT INTO ledger(writer) VALUES ('tx')`;
            return yield* Effect.fail("rollback" as const);
          }),
        ),
      );
      yield* realSleep(5);
      yield* sql`INSERT INTO ledger(writer) VALUES ('outside')`;
      const exit = yield* Fiber.await(transaction);
      assert.isTrue(Exit.isFailure(exit));
      const rows = yield* sql<{ readonly writer: string }>`SELECT writer FROM ledger`;
      assert.deepEqual(
        rows.map((row) => row.writer),
        ["outside"],
      );
    }),
  );
});

it.live("keeps the main event loop responsive while a multi-second statement runs", () =>
  Effect.gen(function* () {
    const entry = resolveNodeSqliteWorkerEntry();
    assert.isDefined(entry);
    const connection = yield* makeWorkerConnection(entry!, {
      filename: join(directory, "slow.sqlite"),
      readonly: false,
      allowExtension: false,
      prepareCacheSize: 10,
    });
    let last = performance.now();
    let maxGapMs = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGapMs = Math.max(maxGapMs, now - last);
      last = now;
    }, 10);
    const startedAt = performance.now();
    const rows = yield* connection
      .execute(
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 20000000) SELECT count(*) AS total FROM n",
        [],
        undefined,
      )
      .pipe(Effect.ensuring(Effect.sync(() => clearInterval(timer))));
    const statementMs = performance.now() - startedAt;
    maxGapMs = Math.max(maxGapMs, performance.now() - last);
    assert.deepEqual(rows, [{ total: 20_000_000 }]);
    // The control: the statement itself must be long enough that running it inline would stall.
    assert.isAbove(statementMs, 500);
    assert.isBelow(maxGapMs, 250);
  }).pipe(Effect.scoped),
);

const fixtureEntry = fileURLToPath(
  new URL("./NodeSqliteWorker.crash.fixture.mjs", import.meta.url),
);
const openFixture = (behaviour: string) =>
  makeWorkerConnection(fixtureEntry, {
    filename: behaviour,
    readonly: false,
    allowExtension: false,
    prepareCacheSize: 10,
  });

it("resolves the source worker entry under tests", () => {
  assert.match(resolveNodeSqliteWorkerEntry() ?? "", /NodeSqliteWorker\.(ts|mjs)$/);
});

for (const [behaviour, sql] of [
  ["crash", "CRASH"],
  ["exit", "EXIT"],
] as const) {
  it.live(`fails pending and later statements when the worker ${behaviour}es`, () =>
    Effect.gen(function* () {
      const connection = yield* openFixture(behaviour);
      const ok = yield* connection.execute("SELECT 1", [], undefined);
      assert.deepEqual(ok, [{ ok: 1 }]);

      const failed = yield* Effect.flip(connection.execute(sql, [], undefined)).pipe(
        Effect.timeout("10 seconds"),
      );
      assert.equal(failed.reason._tag, "ConnectionError");
      assert.match(String(failed.reason.message), /SQLite worker/);

      const later = yield* Effect.flip(connection.execute("SELECT 1", [], undefined)).pipe(
        Effect.timeout("1 second"),
      );
      assert.equal(later.reason._tag, "ConnectionError");
    }).pipe(Effect.scoped),
  );
}

for (const behaviour of ["open-failed", "exit-before-ready"] as const) {
  it.live(`fails startup instead of hanging when the worker reports ${behaviour}`, () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(openFixture(behaviour)).pipe(Effect.timeout("10 seconds"));
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.scoped),
  );
}
