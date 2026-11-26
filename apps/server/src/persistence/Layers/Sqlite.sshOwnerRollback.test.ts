import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  assertSshTargetConnected,
  clearSshTargetDisconnected,
  configureSshTargetDisconnects,
  listDisconnectedSshTargets,
  markSshTargetDisconnected,
} from "../../ssh/sshTargetDisconnects.ts";
import { DatabaseSchemaNewerThanRuntimeError } from "../Migrations.downgradeGuard.ts";
import { latestMigrationId, runMigrations } from "../Migrations.ts";
import { withRemoteExecutionTargetDisconnects } from "./RemoteExecutionTargetDisconnects.ts";
import { makeSqlitePersistenceLive, makeSqliteReadOnlyPersistenceLive } from "./Sqlite.ts";

const preA = 180;
const buildA = 181;
const targetX = "ssh:rollback-x";
const targetY = "ssh:rollback-y";
const makeFilename = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "bigbud-ssh-owner-rollback-"))),
  (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
).pipe(Effect.map((directory) => join(directory, "state.sqlite")));

const readFlags = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ targetId: string; disconnectedAt: number }>`
    SELECT target_id AS targetId, disconnected_at AS disconnectedAt
    FROM remote_execution_target_disconnects ORDER BY target_id`;
});

const fixtureWriter = (filename: string) =>
  Layer.unwrap(
    Effect.promise(async () => {
      if (process.versions.bun !== undefined) {
        const { layer } = await import("@effect/sql-sqlite-bun/SqliteClient");
        return layer({ filename, disableWAL: true });
      }
      const { layer } = await import("../NodeSqliteClient.ts");
      return layer({ filename });
    }),
  );

const livePersistence = (filename: string) =>
  makeSqlitePersistenceLive(filename, { worker: false }).pipe(Layer.provide(NodeServices.layer));

const observeLegacyAdmission = Effect.sync(() => {
  assert.deepEqual(listDisconnectedSshTargets(), [targetX]);
  assert.throws(() => assertSshTargetConnected(targetX), "Remote workspace is disconnected");
  assert.doesNotThrow(() => assertSshTargetConnected(targetY));
});

it.live(
  "boots the legacy writer from a closed pre-A SQLite file without changing the timestamp",
  () =>
    Effect.gen(function* () {
      const filename = yield* makeFilename;
      const migrated = yield* runMigrations({ toMigrationInclusive: preA }).pipe(
        Effect.provide(fixtureWriter(filename)),
      );
      assert.strictEqual(migrated.at(-1)?.[0], preA);
      yield* Effect.gen(function* () {
        assert.isTrue(yield* Effect.promise(() => markSshTargetDisconnected(targetX)));
        yield* observeLegacyAdmission;
      }).pipe(Effect.provide(withRemoteExecutionTargetDisconnects(fixtureWriter(filename))));

      const original = yield* readFlags.pipe(
        Effect.provide(makeSqliteReadOnlyPersistenceLive(filename)),
      );
      assert.lengthOf(original, 1);
      assert.strictEqual(original[0]?.targetId, targetX);
      // A fresh in-memory guard distinguishes rehydration from retaining pre-A's process state.
      configureSshTargetDisconnects(undefined, []);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* readFlags, original);
        yield* observeLegacyAdmission;
        assert.deepEqual(
          yield* sql`SELECT migration_id AS id FROM effect_sql_migrations WHERE migration_id = ${buildA}`,
          [{ id: buildA }],
        );
      }).pipe(Effect.provide(withRemoteExecutionTargetDisconnects(livePersistence(filename))));
    }).pipe(Effect.ensuring(Effect.sync(() => configureSshTargetDisconnects(undefined, [])))),
);

it.live("boots a fresh SQLite file with the legacy writer and reopens the durable flag", () =>
  Effect.gen(function* () {
    const filename = yield* makeFilename;
    const bootLegacy = () => withRemoteExecutionTargetDisconnects(livePersistence(filename));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(yield* sql`PRAGMA journal_mode`, [{ journal_mode: "wal" }]);
      assert.deepEqual(listDisconnectedSshTargets(), []);
      assert.isTrue(yield* Effect.promise(() => markSshTargetDisconnected(targetX)));
    }).pipe(Effect.provide(bootLegacy()));
    configureSshTargetDisconnects(undefined, []);
    yield* Effect.gen(function* () {
      yield* observeLegacyAdmission;
      assert.isTrue(yield* Effect.promise(() => clearSshTargetDisconnected(targetX)));
      assert.deepEqual(yield* readFlags, []);
    }).pipe(Effect.provide(bootLegacy()));
  }).pipe(Effect.ensuring(Effect.sync(() => configureSshTargetDisconnects(undefined, [])))),
);

for (const journalMode of ["delete", "wal"] as const) {
  it.live(`refuses the newer schema without changing ${journalMode} database bytes`, () =>
    Effect.gen(function* () {
      const filename = yield* makeFilename;
      const futureMigrationId = latestMigrationId + 1;
      yield* runMigrations().pipe(Effect.provide(fixtureWriter(filename)));
      // Simulate a newer build committing its schema marker. A hard exit in WAL mode leaves
      // the new marker only in WAL: the refusal must see it without checkpointing on close.
      const bun = process.versions.bun !== undefined;
      execFileSync(
        process.execPath,
        [
          ...(bun ? [] : ["--input-type=module"]),
          "--eval",
          `import { ${bun ? "Database" : "DatabaseSync"} as Database } from "${bun ? "bun:sqlite" : "node:sqlite"}";
         const db = new Database(process.argv[1]);
         db.exec("PRAGMA journal_mode = ${journalMode}");
         db.prepare("INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, 'FutureSchema')")
           .run(Number(process.argv[2]));
         process.exit(0);`,
          filename,
          String(futureMigrationId),
        ],
        { stdio: "pipe" },
      );
      const before = readFileSync(filename);
      const wal = journalMode === "wal" ? readFileSync(`${filename}-wal`) : undefined;
      if (wal) assert.isAbove(wal.length, 32);

      // Use the production startup layer, not just the standalone guard or a migration cutoff.
      const failure = yield* Effect.flip(
        Effect.void.pipe(Effect.provide(livePersistence(filename))),
      );
      assert.instanceOf(failure, DatabaseSchemaNewerThanRuntimeError);
      assert.deepInclude(failure, {
        appliedMigrationId: futureMigrationId,
        appliedMigrationName: "FutureSchema",
        latestKnownMigrationId: latestMigrationId,
      });
      assert.isTrue(readFileSync(filename).equals(before));
      if (wal) assert.isTrue(readFileSync(`${filename}-wal`).equals(wal));
    }),
  );
}
