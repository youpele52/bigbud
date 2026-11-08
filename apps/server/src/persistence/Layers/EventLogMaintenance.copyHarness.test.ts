/**
 * MANUAL harness, skipped unless `BIGBUD_PHASE3_COPY_DB` names a COPY of a real database
 * (never the live file). It migrates the copy, drains the event-log backlog with back-to-back
 * ticks and prints per-kind batch and checkpoint latency (p50, p99, max, share over 50 ms):
 *
 *   BIGBUD_PHASE3_COPY_DB=/tmp/copy.sqlite \
 *     bun run --cwd apps/server vitest run src/persistence/Layers/EventLogMaintenance.copyHarness.test.ts
 */
import { appendFileSync, statSync, statfsSync, writeFileSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { MaintenanceBatchKind } from "./EventLogMaintenance.batches.ts";
import { refuseLiveDatabase } from "./EventLogMaintenance.copyHarness.guard.ts";
import { IDLE_SIGNALS } from "./EventLogMaintenance.test.helpers.ts";
import { makeEventLogMaintenance } from "./EventLogMaintenance.ts";
import { makeSqlitePersistenceLive } from "./Sqlite.ts";

const DB = process.env.BIGBUD_PHASE3_COPY_DB;
// Fail at import, before any layer can open (and migrate) the file.
const refused = DB ? refuseLiveDatabase(DB) : null;
if (refused !== null) {
  throw new Error(`BIGBUD_PHASE3_COPY_DB must name a copy, not a live database: ${refused}`);
}
/** `migrate`: migrate the copy and stop, so it can be probed before the drain. */
const MODE = process.env.BIGBUD_PHASE3_COPY_MODE ?? "drain";
/** Optional JSONL file with one line per batch. */
const TRACE = process.env.BIGBUD_PHASE3_COPY_TRACE;
const round = (ms: number) => Math.round(ms * 100) / 100;
const walBytes = () => {
  try {
    return statSync(`${DB}-wal`).size;
  } catch {
    return 0;
  }
};
const log = (line: string) => process.stderr.write(`[copy] ${line}\n`);
const freeBytes = () => {
  const fs = statfsSync("/tmp");
  return fs.bavail * fs.bsize;
};
const percentile = (values: ReadonlyArray<number>, p: number) => {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
};
const describeTimes = (values: ReadonlyArray<number>) =>
  `n ${values.length} p50 ${percentile(values, 0.5).toFixed(1)} p99 ${percentile(values, 0.99).toFixed(1)} ` +
  `max ${values.reduce((max, ms) => Math.max(max, ms), 0).toFixed(1)} ms, over 50 ms ${values.filter((ms) => ms > 50).length} ` +
  `(${((100 * values.filter((ms) => ms > 50).length) / Math.max(1, values.length)).toFixed(2)}%)`;

it.effect.skipIf(!DB)(
  "drains a copied database and reports batch latency",
  () =>
    Effect.gen(function* () {
      const started = performance.now();
      const timings: Record<MaintenanceBatchKind, { tx: Array<number>; ckpt: Array<number> }> = {
        events: { tx: [], ckpt: [] },
        gaps: { tx: [], ckpt: [] },
        eventIds: { tx: [], ckpt: [] },
        receipts: { tx: [], ckpt: [] },
        orphanClaims: { tx: [], ckpt: [] },
      };
      let traceLines: Array<string> = [];
      if (TRACE) writeFileSync(TRACE, "");
      yield* Effect.gen(function* () {
        log(
          `migrated in ${((performance.now() - started) / 1000).toFixed(1)} s, WAL ${(walBytes() / 1e6).toFixed(0)} MB`,
        );
        const sql = yield* SqlClient.SqlClient;
        if (MODE === "migrate") {
          yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
          log(`checkpointed; WAL ${(walBytes() / 1e6).toFixed(0)} MB`);
          return;
        }
        let peakWal = 0;
        const maintenance = yield* makeEventLogMaintenance({
          readSignals: () => Effect.succeed(IDLE_SIGNALS),
          floorInputs: () => ({ reactorCursor: null, deliveryAcknowledged: null }),
          onBatch: (kind, elapsedMs, rows, size, checkpointMs) => {
            timings[kind].tx.push(elapsedMs);
            timings[kind].ckpt.push(checkpointMs);
            if (TRACE) {
              traceLines.push(
                JSON.stringify({
                  at: Date.now(),
                  kind,
                  rows,
                  size,
                  ms: round(elapsedMs),
                  ckpt: round(checkpointMs),
                }),
              );
            }
          },
        });
        const drainStarted = performance.now();
        let tick = 0;
        for (; tick < 50_000; tick += 1) {
          const report = yield* maintenance.service.runTick;
          peakWal = Math.max(peakWal, walBytes());
          if (TRACE && traceLines.length > 0) {
            appendFileSync(TRACE, `${traceLines.join("\n")}\n`);
            traceLines = [];
          }
          if (report.failed) {
            log(`FAILED: ${(yield* maintenance.service.progress).lastError}`);
            break;
          }
          if (tick % 200 === 0) {
            log(
              `tick ${tick}: backlog ${report.backlogSequences} free ${(freeBytes() / 1e9).toFixed(1)} GB`,
            );
            if (freeBytes() < 4e9) {
              log("ABORT: free disk under 4 GB");
              break;
            }
          }
          if (report.drained) break;
        }
        log(`peak WAL during drain ${(peakWal / 1e6).toFixed(1)} MB`);
        log(
          `drained in ${((performance.now() - drainStarted) / 1000).toFixed(1)} s, ${tick + 1} ticks`,
        );
        for (const [kind, timing] of Object.entries(timings)) {
          log(`${kind} tx: ${describeTimes(timing.tx)}`);
          log(`${kind} checkpoint: ${describeTimes(timing.ckpt)}`);
        }
        const all = Object.values(timings).flatMap((timing) => timing.tx.concat(timing.ckpt));
        log(`all worker holds: ${describeTimes(all)}`);
        const state = yield* sql`SELECT * FROM event_log_maintenance_state`;
        log(`state ${JSON.stringify(state[0])}`);
      }).pipe(
        Effect.provide(makeSqlitePersistenceLive(DB!).pipe(Layer.provide(NodeServices.layer))),
      );
    }),
  { timeout: 14_400_000 },
);
