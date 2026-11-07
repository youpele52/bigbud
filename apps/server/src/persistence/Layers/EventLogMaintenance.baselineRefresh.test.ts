import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  BASELINE_REFRESH_INTERVAL_MS,
  BASELINE_REFRESH_MIN_GAP,
  baselineRefreshTarget,
} from "./EventLogMaintenance.baselineRefresh.ts";
import { makeEventLogMaintenance } from "./EventLogMaintenance.ts";
import type { MaintenanceLoadSignals } from "./EventLogMaintenance.scheduler.ts";
import {
  IDLE_SIGNALS,
  NOW_MS,
  seedCompactableLog,
  TEST_HOT_WINDOW,
  verifyBaselineThrough,
} from "./EventLogMaintenance.test.helpers.ts";
import { type ProjectionRepositoryError, toPersistenceSqlError } from "../Errors.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const EVENT_COUNT = BASELINE_REFRESH_MIN_GAP * 2;
const STALE_BASELINE = 500;

const NO_COMPONENTS = {
  baseline: null,
  projector: null,
  reactor: null,
  delivery: null,
  "hot-window": null,
  cleanup: null,
  "turn-start": null,
  organization: null,
  workspace: null,
} as const;

/** A log whose newest verified baseline covers only its first 500 events. */
const seedStaleBaseline = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const range = yield* seedCompactableLog(sql, { count: EVENT_COUNT, receipts: false });
  yield* sql`DELETE FROM projection_baselines`;
  yield* sql`UPDATE orchestration_retention_state SET compact_through_sequence = 0`;
  yield* verifyBaselineThrough(sql, STALE_BASELINE);
  return range;
});

const makeMaintenance = (input: {
  readonly clock: { nowMs: number };
  readonly refresh: (throughSequence: number) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly signals?: MaintenanceLoadSignals;
}) =>
  makeEventLogMaintenance({
    now: () => input.clock.nowMs,
    readSignals: () => Effect.succeed(input.signals ?? IDLE_SIGNALS),
    floorInputs: () => ({ reactorCursor: null, deliveryAcknowledged: null }),
    hotWindow: TEST_HOT_WINDOW,
    refreshBaseline: input.refresh,
  });

it("targets the floor the other holders allow, only past the minimum gap", () => {
  const head = 100_000;
  const floorWith = (baseline: number, hotWindow: number) => ({
    heldBy: "baseline" as const,
    floor: baseline,
    head,
    components: { ...NO_COMPONENTS, baseline, "hot-window": hotWindow, cleanup: 60_000 },
  });
  assert.equal(baselineRefreshTarget(floorWith(1_000, 90_000)), 60_000);
  assert.isNull(baselineRefreshTarget(floorWith(60_000 - BASELINE_REFRESH_MIN_GAP + 1, 90_000)));
  assert.equal(baselineRefreshTarget(floorWith(60_000 - BASELINE_REFRESH_MIN_GAP, 90_000)), 60_000);
  assert.isNull(baselineRefreshTarget({ ...floorWith(1_000, 90_000), heldBy: "cleanup" }));
});

it.effect("verifies its own baseline when a stale one holds the floor, then drains", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const range = yield* seedStaleBaseline;
    const targets: Array<number> = [];
    const maintenance = yield* makeMaintenance({
      clock: { nowMs: NOW_MS },
      refresh: (throughSequence) =>
        Effect.gen(function* () {
          targets.push(throughSequence);
          yield* verifyBaselineThrough(sql, throughSequence);
        }).pipe(Effect.mapError(toPersistenceSqlError("test:refresh"))),
    });

    const report = yield* maintenance.service.runTick;
    const hotWindowFloor = range.end - TEST_HOT_WINDOW.sequences;
    assert.deepEqual(targets, [hotWindowFloor]);
    assert.equal(report.floorSequence, hotWindowFloor, "the tick re-reads the floor");
    assert.isAbove(report.eventsDeleted, STALE_BASELINE);

    // The new baseline ties with the hot window, so nothing is left to gain from another.
    yield* maintenance.service.runTick;
    assert.equal(targets.length, 1, "no refresh once the baseline no longer lags");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("keeps ticking on the old floor when verification fails, retrying hourly", () =>
  Effect.gen(function* () {
    yield* seedStaleBaseline;
    const clock = { nowMs: NOW_MS };
    let attempts = 0;
    const maintenance = yield* makeMaintenance({
      clock,
      refresh: () =>
        Effect.suspend(() => {
          attempts += 1;
          return Effect.fail(
            toPersistenceSqlError("test:refresh")(new Error("replay hash mismatch")),
          );
        }),
    });

    const report = yield* maintenance.service.runTick;
    assert.isFalse(report.failed);
    assert.equal(report.floorSequence, STALE_BASELINE);
    assert.equal(attempts, 1);

    clock.nowMs += BASELINE_REFRESH_INTERVAL_MS - 1;
    yield* maintenance.service.runTick;
    assert.equal(attempts, 1, "no second attempt inside the interval");

    clock.nowMs += 1;
    yield* maintenance.service.runTick;
    assert.equal(attempts, 2);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("does not capture a baseline while the app is busy", () =>
  Effect.gen(function* () {
    yield* seedStaleBaseline;
    let attempts = 0;
    const maintenance = yield* makeMaintenance({
      clock: { nowMs: NOW_MS },
      signals: { ...IDLE_SIGNALS, eventLoopLagged: true },
      refresh: () =>
        Effect.sync(() => {
          attempts += 1;
        }),
    });
    const report = yield* maintenance.service.runTick;
    assert.equal(report.mode, "skip-soft");
    assert.equal(attempts, 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
