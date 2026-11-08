import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Fiber, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";
import { UsageSqlClient } from "./Services/UsageSqlClient.ts";

assert.ok(process.versions.bun, "This fixture must run in the real Bun runtime");
const filename = process.argv[2];
assert.ok(filename);
const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provideMerge(makeSqlitePersistenceLive(filename)),
  Layer.provide(NodeServices.layer),
);

const run = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const usage = yield* UsageSqlClient;
  const query = yield* ProjectionSnapshotQuery;
  assert.notEqual(sql, usage);
  yield* sql`CREATE TABLE bun_usage_probe (value TEXT)`;
  yield* sql`INSERT INTO bun_usage_probe VALUES ('committed')`;
  assert.deepEqual(yield* usage`SELECT value FROM bun_usage_probe`, [{ value: "committed" }]);
  assert.deepEqual(yield* usage`PRAGMA query_only`, [{ query_only: 1 }]);
  assert.deepEqual(yield* usage`PRAGMA busy_timeout`, [{ timeout: 5000 }]);
  assert.deepEqual(yield* usage`PRAGMA journal_mode`, [{ journal_mode: "wal" }]);
  yield* usage`PRAGMA query_only = OFF`;
  assert.ok(Exit.isFailure(yield* Effect.exit(usage`DELETE FROM bun_usage_probe`)));
  yield* usage`PRAGMA query_only = ON`;
  assert.deepEqual(yield* usage`SELECT ${"bound"} AS value`.values, [["bound"]]);
  assert.deepEqual(yield* usage`SELECT 7 AS value`.unprepared, [{ value: 7 }]);
  assert.deepEqual(yield* usage`PRAGMA busy_timeout`.raw, [{ timeout: 5000 }]);
  const big = 9_007_199_254_740_993n;
  const safe = yield* usage`SELECT ${big} AS value`.pipe(
    Effect.provideService(SqlClient.SafeIntegers, true),
  );
  assert.deepEqual(safe, [{ value: big }]);
  assert.deepEqual(yield* usage`SELECT 7 AS value`, [{ value: 7 }]);
  assert.ok(Exit.isFailure(yield* Effect.exit(usage.unsafe("SELEC invalid"))));
  assert.deepEqual(yield* query.getUsageEntries(null), []);
  yield* query.getUsageHistoryStatus();
  assert.deepEqual(yield* query.getUsageActiveDays("2099-01-01"), []);

  let lastTick = performance.now();
  let maxGapMs = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - lastTick);
    lastTick = now;
    ticks++;
  }, 10);
  let completed = false;
  const startedAt = performance.now();
  yield* Effect.gen(function* () {
    const slow = yield* Effect.forkChild(
      usage
        .unsafe<{ total: number }>(
          "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000000) SELECT count(*) AS total FROM n",
        )
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              completed = true;
            }),
          ),
        ),
    );
    yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));
    yield* query.getCounts().pipe(Effect.timeout("2 seconds"));
    yield* sql`INSERT INTO bun_usage_probe VALUES ('operational during scan')`.pipe(
      Effect.timeout("2 seconds"),
    );
    assert.equal(completed, false, "Operational SQL must finish while usage scan is still running");
    const result = yield* Fiber.join(slow);
    assert.equal(result[0]?.total, 10000000);
  }).pipe(Effect.ensuring(Effect.sync(() => clearInterval(timer))));
  const elapsedMs = performance.now() - startedAt;
  assert.ok(ticks >= 3, `Expected event-loop heartbeat during scan, observed ${ticks}`);
  assert.ok(maxGapMs < Math.max(300, elapsedMs / 2), `Event loop stalled for ${maxGapMs}ms`);
  console.log(JSON.stringify({ runtime: "bun", ticks, maxGapMs, elapsedMs }));
});

await Effect.runPromise(run.pipe(Effect.provide(layer)));
console.log("BUN_USAGE_WORKER_OK");
