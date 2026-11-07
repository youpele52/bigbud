import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeEventLogMaintenance } from "./EventLogMaintenance.ts";
import {
  MAINTENANCE_BACKLOG_INTERVAL_MS,
  MAINTENANCE_SKIP_FLOOR_REFRESH_MS,
} from "./EventLogMaintenance.scheduler.ts";
import {
  IDLE_SIGNALS,
  NOW_MS,
  seedCompactableLog,
  seedEvents,
  setProjectorCursors,
  TEST_HOT_WINDOW,
  verifyBaselineThrough,
} from "./EventLogMaintenance.test.helpers.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const stateWrittenAt = (sql: SqlClient.SqlClient) =>
  sql<{ readonly updatedAt: string }>`
    SELECT updated_at AS "updatedAt" FROM event_log_maintenance_state WHERE singleton_id = 1
  `.pipe(Effect.map((rows) => rows[0]?.updatedAt ?? null));

it.effect("reuses the last floor on soft-skipped ticks, and still sees a new backlog", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedCompactableLog(sql, { count: 1_000 });
    let nowMs = NOW_MS;
    let lagged = true;
    const maintenance = yield* makeEventLogMaintenance({
      now: () => nowMs,
      readSignals: () => Effect.succeed({ ...IDLE_SIGNALS, eventLoopLagged: lagged }),
      floorInputs: () => ({ reactorCursor: null, deliveryAcknowledged: null }),
      hotWindow: TEST_HOT_WINDOW,
    });

    // The first soft skip reads the floor once, so progress has a backlog to report.
    const first = yield* maintenance.service.runTick;
    assert.deepEqual([first.mode, first.backlogSequences], ["skip-soft", 900]);
    const firstWrite = yield* stateWrittenAt(sql);
    assert.equal(firstWrite, new Date(NOW_MS).toISOString());

    // New events arrive while the app stays busy.
    const more = yield* seedEvents(sql, { count: 500, nowMs });
    yield* verifyBaselineThrough(sql, more.end);
    yield* setProjectorCursors(sql, more.end);

    // Later soft skips within the refresh interval neither read the floor nor write the state.
    for (
      nowMs += MAINTENANCE_BACKLOG_INTERVAL_MS;
      nowMs - NOW_MS < MAINTENANCE_SKIP_FLOOR_REFRESH_MS;
      nowMs += MAINTENANCE_BACKLOG_INTERVAL_MS
    ) {
      const report = yield* maintenance.service.runTick;
      assert.deepEqual([report.mode, report.backlogSequences], ["skip-soft", 900]);
    }
    assert.equal(yield* stateWrittenAt(sql), firstWrite);
    assert.equal((yield* maintenance.service.progress).backlogSequences, 900);

    // Once the interval passes, the floor is read again and the new backlog shows: up to the
    // head the server's clock sampled over the hot window ago (the first tick's, 1,000).
    const refreshed = yield* maintenance.service.runTick;
    assert.deepEqual([refreshed.mode, refreshed.backlogSequences], ["skip-soft", 1_000]);
    assert.equal(yield* stateWrittenAt(sql), new Date(nowMs).toISOString());

    // An idle tick reads the floor and drains as before.
    lagged = false;
    nowMs += MAINTENANCE_BACKLOG_INTERVAL_MS;
    const full = yield* maintenance.service.runTick;
    assert.equal(full.mode, "full");
    assert.isAbove(full.eventsDeleted, 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
