import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { DatabaseSchemaNewerThanRuntimeError } from "../Migrations.downgradeGuard.ts";
import { latestMigrationId } from "../Migrations.ts";
import { makeSqlitePersistenceLive } from "./Sqlite.ts";

// A cleanly closed WAL database has no -wal/-shm files. Bun's SQLite cannot open it read-only
// ("unable to open database file"), so the startup schema probe opens it writable when no WAL
// exists. Vitest runs on Node, whose SQLite tolerates the read-only open, so these tests pin the
// boot and the newer-schema refusal on that path; the Bun failure was verified by hand.

const makeFilename = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "bigbud-sqlite-clean-wal-"))),
  (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
).pipe(Effect.map((directory) => join(directory, "state.sqlite")));

const livePersistence = (filename: string) =>
  makeSqlitePersistenceLive(filename, { worker: false }).pipe(Layer.provide(NodeServices.layer));

const removeWalFiles = (filename: string) =>
  Effect.sync(() => {
    rmSync(`${filename}-wal`, { force: true });
    rmSync(`${filename}-shm`, { force: true });
    assert.isFalse(existsSync(`${filename}-wal`));
    assert.isFalse(existsSync(`${filename}-shm`));
  });

const latestApplied = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly id: number }>`
    SELECT MAX(migration_id) AS "id" FROM effect_sql_migrations`;
  return rows[0]?.id;
});

it.live(
  "boots a WAL database whose -wal and -shm files were removed by a clean close",
  () =>
    Effect.gen(function* () {
      const filename = yield* makeFilename;
      assert.strictEqual(
        yield* latestApplied.pipe(Effect.provide(livePersistence(filename))),
        latestMigrationId,
      );
      yield* removeWalFiles(filename);
      assert.strictEqual(
        yield* latestApplied.pipe(Effect.provide(livePersistence(filename))),
        latestMigrationId,
      );
    }).pipe(Effect.scoped),
  120_000,
);

it.live(
  "still refuses a newer schema when no WAL files exist",
  () =>
    Effect.gen(function* () {
      const filename = yield* makeFilename;
      const future = latestMigrationId + 1;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${future}, 'FutureSchema')`;
      }).pipe(Effect.provide(livePersistence(filename)));
      yield* removeWalFiles(filename);
      const error = yield* Effect.flip(
        latestApplied.pipe(Effect.provide(livePersistence(filename))),
      );
      assert.instanceOf(error, DatabaseSchemaNewerThanRuntimeError);
      assert.strictEqual(error.appliedMigrationId, future);
    }).pipe(Effect.scoped),
  120_000,
);
