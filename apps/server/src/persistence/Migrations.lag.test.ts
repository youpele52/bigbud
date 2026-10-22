/**
 * Startup-stall fixture: runs the heavy event backfill migration against a
 * generated file database through the SQLite worker and asserts the main
 * event loop never stalls for a second, while progress arrives in chunks.
 *
 * Trade-off: CI cannot carry a 3 GB database copy, so the fixture generates
 * enough events to need several backfill chunks. It proves chunked progress
 * and an unblocked main thread; absolute timings on a 3 GB database come from
 * the gated benchmark in `NodeSqliteClient.lag.benchmark.test.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterAll } from "vitest";

import { EVENT_BACKFILL_CHUNK_SIZE } from "./Migrations/EventSequenceChunks.ts";
import { runMigrations } from "./Migrations.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const EVENT_COUNT = EVENT_BACKFILL_CHUNK_SIZE * 6;
const MAX_MAIN_THREAD_STALL_MS = 1_000;

const directory = mkdtempSync(join(tmpdir(), "bigbud-migration-lag-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const layer = it.layer(
  Layer.fresh(
    NodeSqliteClient.layer({ filename: join(directory, "fixture.sqlite"), worker: true }),
  ),
  { timeout: 120_000 },
);

/** Measures the longest gap between timer ticks, the same signal the server lag monitor samples. */
function startStallProbe() {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  let last = performance.now();
  let maxGapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
  }, 10);
  return () => {
    clearInterval(timer);
    histogram.disable();
    // A loop blocked for the whole run never ticks, so the trailing gap counts too.
    maxGapMs = Math.max(maxGapMs, performance.now() - last);
    return { maxGapMs, histogramMaxMs: histogram.max / 1e6 };
  };
}

const seedEvents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ${EVENT_COUNT})
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      actor_kind, payload_json, metadata_json
    )
    SELECT
      'event-' || x,
      'thread',
      'thread-' || (x % 997),
      x,
      CASE WHEN x % 1000 = 0 THEN 'thread.deleted' ELSE 'thread.message-sent' END,
      printf('2026-01-01T00:00:00.%09d', x),
      'system',
      json_object('text', hex(randomblob(96))),
      '{}'
    FROM n
  `;
});

/** Markers written by migration 78 next to the single-scan result it must equal. */
const readMarkerSummary = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const markers = yield* sql<{ readonly count: number; readonly maxSequence: number }>`
    SELECT COUNT(*) AS "count", MAX(deletion_sequence) AS "maxSequence"
    FROM orchestration_deletion_markers
  `;
  const expected = yield* sql<{ readonly count: number; readonly maxSequence: number }>`
    SELECT COUNT(*) AS "count", MAX(sequence) AS "maxSequence" FROM (
      SELECT stream_id, MAX(sequence) AS sequence FROM orchestration_events
      WHERE event_type = 'thread.deleted' GROUP BY stream_id
    )
  `;
  return { markers, expected };
});

it.effect(
  "migrates the startup database on the worker before the runtime connection opens",
  () =>
    Effect.gen(function* () {
      const filename = join(directory, "startup.sqlite");
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* runMigrations({ toMigrationInclusive: 77 });
        yield* seedEvents;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename, worker: true })));

      const stopProbe = startStallProbe();
      const summary = yield* readMarkerSummary.pipe(
        Effect.provide(makeSqlitePersistenceLive(filename).pipe(Layer.provide(NodeServices.layer))),
      );
      const stall = stopProbe();
      process.stderr.write(
        `[migration-lag] startup-layer maxGapMs=${stall.maxGapMs.toFixed(1)} ` +
          `histogramMaxMs=${stall.histogramMaxMs.toFixed(1)}\n`,
      );
      assert.isBelow(stall.maxGapMs, MAX_MAIN_THREAD_STALL_MS);
      assert.isAbove(summary.expected[0]?.count ?? 0, 1);
      assert.deepEqual(summary.markers, summary.expected);
    }),
  120_000,
);

layer("migration main-thread stalls", (it) => {
  it.effect(
    "backfills deletion markers in chunks without stalling the main thread",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* runMigrations({ toMigrationInclusive: 77 });
        yield* seedEvents;

        const progress: number[] = [];
        const stopProbe = startStallProbe();
        const startedAt = performance.now();
        yield* runMigrations({
          toMigrationInclusive: 78,
          onProgress: (percent) => progress.push(percent),
        });
        const migrationMs = performance.now() - startedAt;
        yield* runMigrations();
        const stall = stopProbe();
        process.stderr.write(
          `[migration-lag] events=${EVENT_COUNT} migration78Ms=${migrationMs.toFixed(0)} allMs=${(performance.now() - startedAt).toFixed(0)} ` +
            `maxGapMs=${stall.maxGapMs.toFixed(1)} histogramMaxMs=${stall.histogramMaxMs.toFixed(1)}\n`,
        );

        assert.isBelow(stall.maxGapMs, MAX_MAIN_THREAD_STALL_MS);
        assert.isBelow(stall.histogramMaxMs, MAX_MAIN_THREAD_STALL_MS);
        assert.equal(progress[0], 0);
        assert.equal(progress.at(-1), 100);
        // One pending migration: every intermediate value comes from a backfill chunk.
        assert.isAtLeast(progress.filter((value) => value > 0 && value < 100).length, 4);
        assert.deepEqual(
          progress,
          [...progress].toSorted((a, b) => a - b),
        );

        const { markers, expected } = yield* readMarkerSummary;
        assert.deepEqual(markers, expected);
      }),
    120_000,
  );
});
