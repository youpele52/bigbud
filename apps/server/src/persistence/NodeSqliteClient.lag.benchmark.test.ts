/**
 * Gated main-thread stall benchmark against a real database copy.
 *
 *   BIGBUD_SQLITE_LAG_BENCHMARK_DB=/tmp/copy/state.sqlite \
 *     bun run --cwd apps/server vitest run src/persistence/NodeSqliteClient.lag.benchmark.test.ts
 *
 * Add `BIGBUD_SQLITE_WORKER=0` for the in-process baseline. Each step reports
 * its duration and the longest main-thread stall, measured like the server
 * lag monitor (a drift sampler plus `monitorEventLoopDelay`). The migration
 * and replay steps run inside a rolled-back transaction, so the copy is not
 * changed. `bootstrapReplay` rewinds every projector cursor by
 * `BIGBUD_SQLITE_LAG_BENCHMARK_REPLAY_EVENTS` sequences (default 5000) and
 * runs the startup projection bootstrap; attachment side effects go to a
 * temporary state directory.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionPipeline } from "../orchestration/Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../startup/config.ts";
import { OrchestrationEventStoreLive } from "./Layers/OrchestrationEventStore.ts";
import Migration0057 from "./Migrations/057_OrchestrationThreadIdentity.ts";
import Migration0078 from "./Migrations/078_BackfillDeletionMarkers.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const databasePath = process.env.BIGBUD_SQLITE_LAG_BENCHMARK_DB;
const mode = process.env.BIGBUD_SQLITE_WORKER === "0" ? "in-process" : "worker";
const replayEvents = Number(process.env.BIGBUD_SQLITE_LAG_BENCHMARK_REPLAY_EVENTS ?? 5_000);

class RollbackBenchmark {
  readonly _tag = "RollbackBenchmark";
}

const measure = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    let last = performance.now();
    let maxGapMs = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGapMs = Math.max(maxGapMs, now - last);
      last = now;
    }, 20);
    const startedAt = performance.now();
    const exit = yield* Effect.exit(effect);
    const durationMs = performance.now() - startedAt;
    if (exit._tag === "Failure")
      process.stderr.write(`[sqlite-lag] ${label} failed: ${String(exit.cause)}\n`);
    clearInterval(timer);
    histogram.disable();
    maxGapMs = Math.max(maxGapMs, performance.now() - last);
    process.stderr.write(
      `[sqlite-lag] mode=${mode} step=${label} ok=${exit._tag === "Success"} durationMs=${durationMs.toFixed(0)} ` +
        `maxStallMs=${maxGapMs.toFixed(0)} loopDelayP99Ms=${(histogram.percentile(99) / 1e6).toFixed(0)} ` +
        `loopDelayMaxMs=${(histogram.max / 1e6).toFixed(0)}\n`,
    );
  });

const inRolledBackTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(Effect.andThen(effect, Effect.fail(new RollbackBenchmark()))).pipe(
      Effect.catchIf(
        (error) => error instanceof RollbackBenchmark,
        () => Effect.void,
      ),
    );
  });

/**
 * Rewinds every projector cursor, then replays through the startup bootstrap.
 * Events of threads purged since then are dropped from the window first: the
 * projectors reject a message whose thread row no longer exists, a state real
 * startup never reaches because it resumes from a consistent cursor.
 */
const bootstrapReplay = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pipeline = yield* OrchestrationProjectionPipeline;
  yield* sql`
    UPDATE projection_state
    SET last_applied_sequence = MAX(0, last_applied_sequence - ${replayEvents})
  `;
  yield* sql`
    DELETE FROM orchestration_events
    WHERE sequence > (SELECT MIN(last_applied_sequence) FROM projection_state)
      AND aggregate_kind = 'thread'
      AND stream_id NOT IN (SELECT thread_id FROM projection_threads)
  `;
  const rows = yield* sql<{ readonly events: number }>`
    SELECT COUNT(*) AS events FROM orchestration_events
    WHERE sequence > (SELECT MIN(last_applied_sequence) FROM projection_state)
  `;
  process.stderr.write(`[sqlite-lag] mode=${mode} replayEvents=${rows[0]?.events ?? 0}\n`);
  yield* pipeline.bootstrap;
});

describe.skipIf(!databasePath)("SQLite main-thread stall benchmark", () => {
  const layer = it.layer(
    Layer.mergeAll(
      OrchestrationProjectionSnapshotQueryLive,
      OrchestrationProjectionPipelineLive,
    ).pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-lag-bench-" })),
      Layer.provideMerge(
        NodeSqliteClient.layer({ filename: databasePath ?? ":memory:", worker: mode === "worker" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
    { timeout: 600_000 },
  );

  layer("real database copy", (it) => {
    it.effect(
      "measures stalls for migrations and read-model queries",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const snapshots = yield* ProjectionSnapshotQuery;
          yield* sql`PRAGMA busy_timeout = 5000`;
          yield* measure("migration078", inRolledBackTransaction(Migration0078));
          yield* measure("migration057", inRolledBackTransaction(Migration0057));
          yield* measure("getCounts", snapshots.getCounts());
          yield* measure("getUsageEntries", snapshots.getUsageEntries(null));
          yield* measure("getUsageHistoryStatus", snapshots.getUsageHistoryStatus());
          yield* measure("getSnapshot", snapshots.getSnapshot());
          yield* measure("bootstrapReplay", inRolledBackTransaction(bootstrapReplay));
        }),
      600_000,
    );
  });
});
