import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeEventLogMaintenance } from "./EventLogMaintenance.ts";
import {
  decideTick,
  MAINTENANCE_BACKLOG_INTERVAL_MS,
  MAINTENANCE_BATCH,
  MAINTENANCE_GUARANTEED_PROGRESS_MS,
  MAINTENANCE_STARVED_AFTER_MS,
  updateBacklogWatermark,
} from "./EventLogMaintenance.scheduler.ts";
import {
  IDLE_SIGNALS,
  NOW_MS,
  seedEvents,
  setProjectorCursors,
  TEST_HOT_WINDOW,
  verifyBaselineThrough,
} from "./EventLogMaintenance.test.helpers.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

describe("guaranteed progress rules", () => {
  const base = {
    nowMs: NOW_MS,
    signals: { ...IDLE_SIGNALS, eventLoopLagged: true },
    backlog: 1_000,
    lastProgressAtMs: NOW_MS - MAINTENANCE_GUARANTEED_PROGRESS_MS,
    backoffUntilMs: null,
  };

  it("forces a minimum batch under soft load once 10 minutes pass without one", () => {
    assert.equal(decideTick(base).mode, "minimum");
    assert.equal(decideTick({ ...base, lastProgressAtMs: NOW_MS - 60_000 }).mode, "skip-soft");
    assert.equal(decideTick({ ...base, backlog: 0 }).mode, "skip-soft");
  });

  it("lets only the hard ceiling skip it", () => {
    const hard = { ...base, signals: { ...base.signals, queueDepth: 17 } };
    assert.equal(decideTick(hard).mode, "skip-hard");
    const inFlight = { ...base, signals: { ...base.signals, batchInFlight: true } };
    assert.equal(decideTick(inFlight).mode, "skip-hard");
    const deep = { ...base, signals: { ...base.signals, queueDepth: 16, streamingTurns: 5 } };
    assert.equal(decideTick(deep).mode, "minimum");
  });

  it("flags a backlog that has not shrunk back for 24 hours, and clears it once it does", () => {
    let mark = updateBacklogWatermark(
      { lowWater: 0, lowWaterAtMs: null, starvedSinceMs: null },
      100,
      0,
    );
    mark = updateBacklogWatermark(mark, 500, MAINTENANCE_STARVED_AFTER_MS - 1);
    assert.equal(mark.starvedSinceMs, null);
    mark = updateBacklogWatermark(mark, 900, MAINTENANCE_STARVED_AFTER_MS);
    assert.equal(mark.starvedSinceMs, MAINTENANCE_STARVED_AFTER_MS);
    mark = updateBacklogWatermark(mark, 90, MAINTENANCE_STARVED_AFTER_MS + 1);
    assert.equal(mark.starvedSinceMs, null);
  });
});

it.effect(
  "under constant soft pressure, runs a minimum batch every 10 minutes and reports starvation",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const range = yield* seedEvents(sql, { count: 2_000 });
      yield* verifyBaselineThrough(sql, range.end);
      yield* setProjectorCursors(sql, range.end);
      let nowMs = NOW_MS;
      let queueDepth = 0;
      const maintenance = yield* makeEventLogMaintenance({
        now: () => nowMs,
        readSignals: () => Effect.succeed({ ...IDLE_SIGNALS, streamingTurns: 3, queueDepth }),
        floorInputs: () => ({ reactorCursor: null, deliveryAcknowledged: null }),
        hotWindow: TEST_HOT_WINDOW,
      });

      // One simulated hour of 15-second ticks under soft load.
      const minimumAt: Array<number> = [];
      // When the backlog last fell back to its lowest value: starvation is measured from there.
      let lowest = Number.POSITIVE_INFINITY;
      let lowestAt = nowMs;
      const tick = Effect.gen(function* () {
        const report = yield* maintenance.service.runTick;
        // A hard-skipped tick reads nothing, so it carries the previous backlog unmeasured.
        if (report.mode !== "skip-hard" && report.backlogSequences <= lowest) {
          lowest = report.backlogSequences;
          lowestAt = nowMs;
        }
        return report;
      });
      for (let elapsed = 0; elapsed <= 60 * 60_000; elapsed += MAINTENANCE_BACKLOG_INTERVAL_MS) {
        nowMs = NOW_MS + elapsed;
        const report = yield* tick;
        if (report.mode === "minimum") {
          // One batch per minimum tick: events every other one, a ledger kind in between.
          assert.equal(report.batches, 1);
          assert.equal(
            report.eventsDeleted,
            minimumAt.length % 2 === 0 ? MAINTENANCE_BATCH.min : 0,
          );
          minimumAt.push(elapsed);
        } else {
          assert.equal(report.mode, "skip-soft");
        }
      }
      assert.deepEqual(
        minimumAt,
        [1, 2, 3, 4, 5, 6].map((step) => step * MAINTENANCE_GUARANTEED_PROGRESS_MS),
      );

      // The hard ceiling skips even an overdue minimum batch.
      queueDepth = 17;
      nowMs += MAINTENANCE_GUARANTEED_PROGRESS_MS;
      assert.equal((yield* tick).mode, "skip-hard");
      queueDepth = 0;

      // New work outpaces one batch per 10 minutes for a day: the backlog grows, so `starved`.
      const startedStarving = nowMs;
      let starvedAt: number | null = null;
      while (nowMs - startedStarving <= MAINTENANCE_STARVED_AFTER_MS + 60 * 60_000) {
        nowMs += MAINTENANCE_GUARANTEED_PROGRESS_MS;
        const more = yield* seedEvents(sql, { count: 150, nowMs, ageMs: 2 * 60 * 60_000 });
        yield* verifyBaselineThrough(sql, more.end);
        yield* setProjectorCursors(sql, more.end);
        yield* tick;
        if (starvedAt === null && (yield* maintenance.service.progress).starved) starvedAt = nowMs;
      }
      assert.isNotNull(starvedAt);
      assert.isAtLeast(starvedAt! - lowestAt, MAINTENANCE_STARVED_AFTER_MS);
      assert.isBelow(
        starvedAt! - lowestAt,
        MAINTENANCE_STARVED_AFTER_MS + MAINTENANCE_GUARANTEED_PROGRESS_MS,
      );
      const progress = yield* maintenance.service.progress;
      assert.isTrue(progress.starved);
      assert.equal(progress.state, "draining");
      const stored = yield* sql<{ readonly starved: number }>`
      SELECT starved FROM event_log_maintenance_state WHERE singleton_id = 1
    `;
      assert.equal(stored[0]?.starved, 1);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
