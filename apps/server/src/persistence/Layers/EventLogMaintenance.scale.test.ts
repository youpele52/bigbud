import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { MaintenanceBatchKind } from "./EventLogMaintenance.batches.ts";
import { makeEventLogMaintenance } from "./EventLogMaintenance.ts";
import { MAINTENANCE_BATCH, MAINTENANCE_MAX_BATCH_PAGES } from "./EventLogMaintenance.scheduler.ts";
import {
  countRows,
  IDLE_SIGNALS,
  NOW_MS,
  readRetention,
  seedCompactableLog,
} from "./EventLogMaintenance.test.helpers.ts";
import { makeSqlitePersistenceLive } from "./Sqlite.ts";

const EVENTS = 200_000;
const HOT_WINDOW = { sequences: 50_000, ms: 60_000 } as const;
/** Heap growth allowed while draining; the log itself lives in SQLite, not in the JS heap. */
const HEAP_GROWTH_LIMIT_BYTES = 64 * 1024 * 1024;

interface KindTimings {
  readonly batches: Array<number>;
  readonly checkpoints: Array<number>;
  rows: number;
}

const percentile = (values: ReadonlyArray<number>, p: number) => {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
};

/**
 * Runs on a file database in WAL mode on the SQLite worker, with IDs scattered over their
 * indexes like the real log, so each batch dirties index pages and pays commit and checkpoint
 * costs as in production. Regression guard for batches that committed past the WAL
 * autocheckpoint size and ran the checkpoint inside the transaction (150 ms to 2 s on 8 GB).
 */
it.effect(
  "drains 200,000 events with every statement type and checkpoint at p99 within 50 ms",
  () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        mkdtemp(path.join(tmpdir(), "bigbud-maintenance-scale-")),
      );
      const timings: Record<MaintenanceBatchKind, KindTimings> = {
        events: { batches: [], checkpoints: [], rows: 0 },
        gaps: { batches: [], checkpoints: [], rows: 0 },
        eventIds: { batches: [], checkpoints: [], rows: 0 },
        receipts: { batches: [], checkpoints: [], rows: 0 },
        orphanClaims: { batches: [], checkpoints: [], rows: 0 },
      };
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedCompactableLog(sql, { count: EVENTS, scatter: true });
        yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
        const maintenance = yield* makeEventLogMaintenance({
          now: () => NOW_MS,
          readSignals: () => Effect.succeed(IDLE_SIGNALS),
          floorInputs: () => ({ reactorCursor: null, deliveryAcknowledged: null }),
          hotWindow: HOT_WINDOW,
          onBatch: (kind, elapsedMs, rows, _size, checkpointMs) => {
            timings[kind].batches.push(elapsedMs);
            timings[kind].checkpoints.push(checkpointMs);
            timings[kind].rows += rows;
          },
        });
        globalThis.gc?.();
        const heapBefore = process.memoryUsage().heapUsed;
        let heapPeak = heapBefore;
        const startedAt = performance.now();
        let ticks = 0;
        for (; ticks < 2_000; ticks += 1) {
          const report = yield* maintenance.service.runTick;
          assert.isFalse(report.failed);
          heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
          if (report.drained) break;
        }
        const totalMs = performance.now() - startedAt;
        for (const [kind, timing] of Object.entries(timings)) {
          process.stderr.write(
            `[scale] ${kind}: ${timing.batches.length} batches, ${timing.rows} rows, ` +
              `p50 ${percentile(timing.batches, 0.5).toFixed(1)} p99 ${percentile(timing.batches, 0.99).toFixed(1)} ` +
              `max ${Math.max(0, ...timing.batches).toFixed(1)} ms; checkpoint max ` +
              `${Math.max(0, ...timing.checkpoints).toFixed(1)} ms\n`,
          );
        }
        process.stderr.write(
          `[scale] ${ticks + 1} ticks, ${totalMs.toFixed(0)} ms, heap growth ` +
            `${((heapPeak - heapBefore) / 1024 / 1024).toFixed(1)} MB\n`,
        );

        assert.equal((yield* readRetention(sql)).retained, EVENTS - HOT_WINDOW.sequences);
        assert.equal(yield* countRows(sql, "orchestration_events"), HOT_WINDOW.sequences);
        assert.equal(yield* countRows(sql, "orchestration_event_ids"), HOT_WINDOW.sequences);
        assert.equal(yield* countRows(sql, "orchestration_command_receipts"), HOT_WINDOW.sequences);
        // Per statement type: the sizer keeps p99 within the 50 ms target. Single fsync stalls
        // of the shared disk can still land anywhere (measured up to ~340 ms, at any batch size),
        // so they are bounded by share, plus a guard against a runaway batch size.
        const target = MAINTENANCE_BATCH.targetMs;
        for (const [kind, timing] of Object.entries(timings)) {
          assert.isAbove(timing.batches.length, 0, kind);
          for (const samples of [timing.batches, timing.checkpoints]) {
            assert.isAtMost(percentile(samples, 0.99), target, kind);
            const over = samples.filter((ms) => ms > target).length;
            assert.isAtMost(over, Math.max(2, Math.ceil(samples.length * 0.01)), kind);
            assert.isAtMost(Math.max(...samples), target * 10, kind);
          }
        }
        // No batch was allowed to commit past the WAL autocheckpoint size.
        const [wal] = yield* sql<{ readonly log: number }>`PRAGMA wal_checkpoint(PASSIVE)`;
        assert.isAtMost(wal?.log ?? 0, MAINTENANCE_MAX_BATCH_PAGES);
        assert.isAtMost(heapPeak - heapBefore, HEAP_GROWTH_LIMIT_BYTES);
      }).pipe(
        Effect.provide(
          makeSqlitePersistenceLive(path.join(dir, "state.sqlite")).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
        Effect.ensuring(Effect.promise(() => rm(dir, { recursive: true, force: true }))),
      );
    }),
  { timeout: 300_000 },
);
