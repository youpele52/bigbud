import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import { makeEventLogMaintenance } from "./EventLogMaintenance.ts";
import {
  MAINTENANCE_BATCH,
  MAINTENANCE_FAILURE_BACKOFF_MS,
  MAINTENANCE_MAX_BATCH_PAGES,
  BatchSizer,
} from "./EventLogMaintenance.scheduler.ts";
import {
  countRows,
  IDLE_SIGNALS,
  NOW_MS,
  readRetention,
  seedCompactableLog,
  TEST_HOT_WINDOW,
} from "./EventLogMaintenance.test.helpers.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

describe("predictive batch size", () => {
  const settle = (cost: { readonly msPerRow: number; readonly pagesPerRow: number }) => {
    const sizer = new BatchSizer();
    const batches: Array<{ size: number; ms: number; pages: number }> = [];
    for (let batch = 0; batch < 40; batch += 1) {
      const size = sizer.size;
      const ms = size * cost.msPerRow;
      const pages = size * cost.pagesPerRow;
      batches.push({ size, ms, pages });
      sizer.record(size, ms, pages);
      assert.isAtLeast(sizer.size, MAINTENANCE_BATCH.min);
      assert.isAtMost(sizer.size, MAINTENANCE_BATCH.max);
    }
    return batches;
  };

  it("keeps every batch within 50 ms and under the WAL autocheckpoint size", () => {
    // Per-row costs from the 8 GB copy (events ~0.037 ms and ~3.9 pages a row) and cheaper ones.
    for (const cost of [
      { msPerRow: 0.037, pagesPerRow: 3.9 },
      { msPerRow: 0.004, pagesPerRow: 0.2 },
      { msPerRow: 0.001, pagesPerRow: 0 },
      { msPerRow: 0.2, pagesPerRow: 1 },
    ]) {
      for (const batch of settle(cost)) {
        if (batch.size === MAINTENANCE_BATCH.min) continue;
        assert.isAtMost(batch.ms, MAINTENANCE_BATCH.targetMs);
        assert.isAtMost(batch.pages, MAINTENANCE_MAX_BATCH_PAGES);
      }
    }
  });

  it("starts at the minimum and grows at most 2x after a full batch", () => {
    const sizer = new BatchSizer();
    assert.equal(sizer.size, MAINTENANCE_BATCH.min);
    assert.equal(sizer.record(100, 1, 10), 200);
    assert.equal(sizer.record(200, 2, 20), 400);
    // A partial batch never grows the size.
    assert.equal(sizer.record(10, 0.1, 1), 400);
  });

  it("shrinks before the next batch after one slow batch, and remembers it for three", () => {
    const sizer = new BatchSizer();
    sizer.size = 4_000;
    // One batch hit a 400 ms spike: the next three are sized from that per-row cost.
    assert.equal(sizer.record(4_000, 400, 100), 200);
    assert.equal(sizer.record(200, 1, 10), 200);
    assert.equal(sizer.record(200, 1, 10), 200);
    assert.isAbove(sizer.record(200, 1, 10), 200);
  });
});

const makeMaintenance = (
  overrides: Partial<Parameters<typeof makeEventLogMaintenance>[0] & object> = {},
) =>
  makeEventLogMaintenance({
    now: () => NOW_MS,
    readSignals: () => Effect.succeed(IDLE_SIGNALS),
    floorInputs: () => ({ reactorCursor: null, deliveryAcknowledged: null }),
    hotWindow: TEST_HOT_WINDOW,
    ...overrides,
  });

it.effect("is skipped under worker-queue pressure", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedCompactableLog(sql, { count: 2_000 });
    const soft = yield* makeMaintenance({
      readSignals: () => Effect.succeed({ ...IDLE_SIGNALS, queueDepth: 5 }),
    });
    const softReport = yield* soft.service.runTick;
    assert.deepEqual([softReport.mode, softReport.reason], ["skip-soft", "worker-queue"]);
    assert.equal(softReport.backlogSequences, 1_900);
    const hard = yield* makeMaintenance({
      readSignals: () => Effect.succeed({ ...IDLE_SIGNALS, queueDepth: 17 }),
    });
    assert.equal((yield* hard.service.runTick).mode, "skip-hard");
    assert.equal(yield* countRows(sql, "orchestration_events"), 2_000);
    assert.equal((yield* readRetention(sql)).retained, 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("drains below the floor in budgeted ticks and keeps the hot window", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedCompactableLog(sql, { count: 5_000 });
    const maintenance = yield* makeMaintenance();
    let longest = 0;
    for (let tick = 0; tick < 50; tick += 1) {
      const report = yield* maintenance.service.runTick;
      assert.equal(report.mode, "full");
      longest = Math.max(longest, report.longestBatchMs);
      if (report.drained) break;
    }
    assert.equal((yield* readRetention(sql)).retained, 4_900);
    assert.equal(yield* countRows(sql, "orchestration_events"), 100);
    assert.equal(yield* countRows(sql, "orchestration_event_ids"), 100);
    const progress = yield* maintenance.service.progress;
    assert.deepEqual([progress.state, progress.backlogSequences], ["idle", 0]);
    // Progress keeps the longest batch of the process run: exactly the longest any tick saw.
    assert.equal(progress.longestBatchMs, longest);
    assert.isAbove(longest, 0, "batches were timed");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("rolls back a batch that fails mid-transaction, backs off, then resumes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedCompactableLog(sql, { count: 2_000 });
    let nowMs = NOW_MS;
    const crashing = yield* makeMaintenance({
      now: () => nowMs,
      // Deletes inside the transaction, then fails before it commits.
      compact: () =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM orchestration_events WHERE sequence <= 500`;
              yield* sql`UPDATE orchestration_retention_state SET retained_through_sequence = 500`;
              return yield* Effect.fail(new Error("worker lost mid-batch"));
            }),
          )
          .pipe(Effect.mapError(toPersistenceSqlError("test.crash"))),
    });
    const failed = yield* crashing.service.runTick;
    assert.isTrue(failed.failed);
    assert.equal(yield* countRows(sql, "orchestration_events"), 2_000);
    assert.equal((yield* readRetention(sql)).retained, 0);
    const progress = yield* crashing.service.progress;
    assert.equal(progress.state, "backing-off");
    assert.match(progress.lastError ?? "", /worker lost mid-batch/);
    // Backoff is not load: the tick still reports idleness so attachment work keeps its cadence.
    const backoff = yield* crashing.service.runTick;
    assert.deepEqual([backoff.mode, backoff.idle], ["backoff", true]);

    // A fresh instance (a restart) reads the stored backoff and resumes once it has passed.
    nowMs += MAINTENANCE_FAILURE_BACKOFF_MS - 1_000;
    const restarted = yield* makeMaintenance({ now: () => nowMs });
    assert.equal((yield* restarted.service.runTick).mode, "backoff");
    nowMs += 2_000;
    const resumed = yield* restarted.service.runTick;
    assert.deepEqual([resumed.mode, resumed.failed], ["full", false]);
    assert.isAbove((yield* readRetention(sql)).retained, 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("resumes from retained_through_sequence after a restart", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedCompactableLog(sql, { count: 3_000 });
    let nowMs = NOW_MS;
    const pressured = yield* makeMaintenance({
      // A guaranteed-progress tick: soft load, and no batch for over 10 minutes.
      now: () => nowMs,
      readSignals: () => Effect.succeed({ ...IDLE_SIGNALS, streamingTurns: 3 }),
    });
    assert.equal((yield* pressured.service.runTick).mode, "skip-soft");
    nowMs += 11 * 60_000;
    const first = yield* pressured.service.runTick;
    assert.equal(first.mode, "minimum");
    assert.equal(first.eventsDeleted, MAINTENANCE_BATCH.min);
    assert.equal((yield* readRetention(sql)).retained, MAINTENANCE_BATCH.min);

    const restarted = yield* makeMaintenance({ now: () => nowMs });
    const next = yield* restarted.service.runTick;
    assert.equal(next.mode, "full");
    assert.equal(
      yield* countRows(sql, "orchestration_events"),
      3_000 - first.eventsDeleted - next.eventsDeleted,
    );
    const remaining = yield* sql<{ readonly first: number }>`
      SELECT MIN(sequence) AS "first" FROM orchestration_events
    `;
    assert.equal(remaining[0]?.first, next.retainedThroughSequence + 1);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
