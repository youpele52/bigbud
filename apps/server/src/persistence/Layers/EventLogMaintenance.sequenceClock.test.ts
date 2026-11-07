import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { readEventLogFloor } from "./EventLogMaintenance.floor.ts";
import {
  readSequenceClockFloor,
  recordSequenceClock,
  SEQUENCE_CLOCK_SAMPLE_INTERVAL_MS,
} from "./EventLogMaintenance.sequenceClock.ts";
import {
  DAY_MS,
  NOW_MS,
  seedEvents,
  setProjectorCursors,
  verifyBaselineThrough,
} from "./EventLogMaintenance.test.helpers.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const HOUR_MS = 60 * 60_000;
const WINDOW = { sequences: 100, ms: DAY_MS } as const;

const sampleCount = (sql: SqlClient.SqlClient) =>
  sql<{ readonly count: number }>`SELECT COUNT(*) AS "count" FROM event_log_sequence_clock`.pipe(
    Effect.map((rows) => rows[0]?.count ?? 0),
  );

it.effect("samples at most every 5 minutes and keeps only the samples still needed", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const record = (nowMs: number, head: number) =>
      recordSequenceClock(sql, { nowMs, head, windowMs: DAY_MS });
    assert.isTrue(yield* record(NOW_MS, 10));
    assert.isFalse(yield* record(NOW_MS + SEQUENCE_CLOCK_SAMPLE_INTERVAL_MS - 1, 11));
    // A clock that moved back by less than an interval records nothing until it passes the
    // newest sample again (a larger jump drops the future-dated samples; see below).
    assert.isFalse(yield* record(NOW_MS - 60_000, 12));
    for (let hour = 1; hour <= 30; hour += 1) yield* record(NOW_MS + hour * HOUR_MS, 10 + hour);
    const nowMs = NOW_MS + 30 * HOUR_MS;
    // The newest sample a day old (hour 6) is the boundary; older ones are gone.
    assert.equal(yield* readSequenceClockFloor(sql, { nowMs, windowMs: DAY_MS }), 16);
    assert.equal(yield* sampleCount(sql), 25);
    assert.isNull(yield* readSequenceClockFloor(sql, { nowMs: NOW_MS, windowMs: DAY_MS }));
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("keeps events a slow client clock dates over a day old while they are recent", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Events written over a day ago by the server's clock.
    const old = yield* seedEvents(sql, { count: 1_000, ageMs: 3 * DAY_MS });
    yield* recordSequenceClock(sql, {
      nowMs: NOW_MS - 2 * DAY_MS,
      head: old.end,
      windowMs: DAY_MS,
    });
    // Written in the last hour, but by a client whose clock runs two days slow.
    const recent = yield* seedEvents(sql, { count: 500, ageMs: 2 * DAY_MS });
    yield* recordSequenceClock(sql, {
      nowMs: NOW_MS - HOUR_MS,
      head: recent.end,
      windowMs: DAY_MS,
    });
    yield* verifyBaselineThrough(sql, recent.end);
    yield* setProjectorCursors(sql, recent.end);
    const floor = yield* readEventLogFloor(sql, {
      nowMs: NOW_MS,
      reactorCursor: null,
      deliveryAcknowledged: null,
      hotWindow: WINDOW,
    });
    assert.equal(floor.heldBy, "hot-window");
    assert.equal(floor.floor, old.end, "only events the server saw a day ago may go");

    // Without a day-old sample, `occurred_at` alone decides (the recent events look old).
    yield* sql`DELETE FROM event_log_sequence_clock`;
    const fallback = yield* readEventLogFloor(sql, {
      nowMs: NOW_MS,
      reactorCursor: null,
      deliveryAcknowledged: null,
      hotWindow: WINDOW,
    });
    assert.equal(fallback.floor, recent.end - WINDOW.sequences);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("recovers from a sample dated in the future by a clock that jumped forward", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const record = (nowMs: number, head: number) =>
      recordSequenceClock(sql, { nowMs, head, windowMs: DAY_MS });
    assert.isTrue(yield* record(NOW_MS, 10));
    // The clock jumps 7 days ahead for one tick, then is corrected.
    assert.isTrue(yield* record(NOW_MS + 7 * DAY_MS, 20));
    assert.isTrue(yield* record(NOW_MS + SEQUENCE_CLOCK_SAMPLE_INTERVAL_MS, 30));
    const samples = yield* sql<{ readonly at: number }>`
      SELECT observed_at_ms AS "at" FROM event_log_sequence_clock ORDER BY observed_at_ms
    `;
    assert.deepEqual(
      samples.map((row) => row.at),
      [NOW_MS, NOW_MS + SEQUENCE_CLOCK_SAMPLE_INTERVAL_MS],
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
