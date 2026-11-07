import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { UsageSqlClient } from "../Services/UsageSqlClient.ts";
import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./Sqlite.ts";

const directory = mkdtempSync(join(tmpdir(), "bigbud-usage-sqlite-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const persistence = makeSqlitePersistenceLive(join(directory, "usage.sqlite")).pipe(
  Layer.provide(NodeServices.layer),
);
const live = OrchestrationProjectionSnapshotQueryLive.pipe(Layer.provideMerge(persistence));

it.live("opens a distinct read-only usage connection after migrations, with WAL visibility", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const usage = yield* UsageSqlClient;
    assert.notStrictEqual(sql, usage);
    // This schema only exists once migrations have completed.
    yield* usage`SELECT thread_id FROM projection_threads LIMIT 1`;
    assert.deepEqual(yield* usage`PRAGMA query_only`, [{ query_only: 1 }]);
    assert.deepEqual(yield* usage`PRAGMA busy_timeout`, [{ timeout: 5000 }]);
    assert.deepEqual(yield* usage`PRAGMA journal_mode`, [{ journal_mode: "wal" }]);
    // The writer commits without a per-commit fsync (1 = NORMAL).
    assert.deepEqual(yield* sql`PRAGMA synchronous`, [{ synchronous: 1 }]);
    yield* sql`CREATE TABLE usage_connection_probe (value TEXT)`;
    yield* sql`INSERT INTO usage_connection_probe VALUES ('committed')`;
    assert.deepEqual(yield* usage`SELECT value FROM usage_connection_probe`, [
      { value: "committed" },
    ]);
    assert.isTrue(Exit.isFailure(yield* Effect.exit(usage`DELETE FROM usage_connection_probe`)));
    // SQLite's read-only open flag still protects the database if query_only is disabled.
    yield* usage`PRAGMA query_only = OFF`;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(usage`DELETE FROM usage_connection_probe`)));
    yield* usage`PRAGMA query_only = ON`;
  }).pipe(Effect.provide(live)),
);

it.live(
  "routes usage reads outside the operational queue and keeps counts on operational SQL",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const held = yield* Effect.forkChild(
        sql.withTransaction(
          Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release)),
        ),
      );
      yield* Deferred.await(entered);
      yield* Effect.gen(function* () {
        yield* query.getUsageEntries(null).pipe(Effect.timeout("2 seconds"));
        yield* query.getUsageHistoryStatus().pipe(Effect.timeout("2 seconds"));
        yield* query.getUsageActiveDays("2099-01-01").pipe(Effect.timeout("2 seconds"));
        const counts = yield* Effect.forkChild(query.getCounts());
        // Yield so the count query attempts to acquire its connection.
        yield* Effect.yieldNow;
        assert.isUndefined(counts.pollUnsafe());
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(counts);
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      yield* Fiber.join(held);
    }).pipe(Effect.provide(live)),
);

it.live("does not queue operational reads or writes behind an occupied usage connection", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const usage = yield* UsageSqlClient;
    const query = yield* ProjectionSnapshotQuery;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const held = yield* Effect.forkChild(
      usage.withTransaction(
        Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release)),
      ),
    );
    yield* Deferred.await(entered);
    yield* Effect.gen(function* () {
      yield* query.getCounts().pipe(Effect.timeout("2 seconds"));
      yield* sql`CREATE TABLE operational_probe (value TEXT)`.pipe(Effect.timeout("2 seconds"));
      yield* sql`INSERT INTO operational_probe VALUES ('not queued')`.pipe(
        Effect.timeout("2 seconds"),
      );
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
    yield* Fiber.join(held);
  }).pipe(Effect.provide(live)),
);

it.live("preserves usage queries with the shared in-memory test connection", () =>
  Effect.gen(function* () {
    const query = yield* ProjectionSnapshotQuery;
    assert.deepEqual(yield* query.getUsageEntries(null), []);
    yield* query.getUsageHistoryStatus();
    assert.deepEqual(yield* query.getUsageActiveDays("2099-01-01"), []);
    yield* query.getCounts();
  }).pipe(
    Effect.provide(
      OrchestrationProjectionSnapshotQueryLive.pipe(Layer.provide(SqlitePersistenceMemory)),
    ),
  ),
);
