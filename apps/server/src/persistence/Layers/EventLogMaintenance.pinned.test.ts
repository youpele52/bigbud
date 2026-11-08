import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeEventLogMaintenance } from "./EventLogMaintenance.ts";
import {
  EVENT_LOG_FLOOR_PINNED_WARN_MS,
  isEventLogFloorPinned,
  readEventLogFloor,
} from "./EventLogMaintenance.floor.ts";
import {
  DAY_MS,
  IDLE_SIGNALS,
  NOW_MS,
  seedCompactableLog,
  TEST_HOT_WINDOW,
  verifyBaselineThrough,
} from "./EventLogMaintenance.test.helpers.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const floorAt = (sql: SqlClient.SqlClient, nowMs: number = NOW_MS) =>
  readEventLogFloor(sql, {
    nowMs,
    reactorCursor: null,
    deliveryAcknowledged: null,
    hotWindow: TEST_HOT_WINDOW,
  });

const insertOpenIntent = (sql: SqlClient.SqlClient, eventId: string) => {
  const now = new Date(NOW_MS).toISOString();
  return sql`
    INSERT INTO direct_resource_cleanup_intents (intent_id, event_id, source_command_id,
      source_payload_digest_version, source_payload_digest, entity_kind, entity_id,
      deletion_mode, deletion_requested_at, state)
    VALUES ('intent-1', ${eventId}, 'command-500', 'v1', 'digest', 'thread', 'thread-1',
      'single', ${now}, 'open')
  `;
};

const insertPlan = (sql: SqlClient.SqlClient, state: string) => {
  const now = new Date(NOW_MS).toISOString();
  return sql`
    INSERT INTO direct_resource_cleanup_plans (operation_id, intent_id, finalize_command_id,
      finalize_payload_json, finalize_payload_digest_version, finalize_payload_digest,
      plan_digest, expected_platform, state, last_error_code, created_at, updated_at)
    VALUES ('plan-1', 'intent-1', 'command-400', '{}', 'v1', 'digest', 'plan', 'darwin/arm64',
      ${state}, 'retry_budget_exhausted', ${now}, ${now})
  `;
};

it("treats a floor as pinned only once it has been held for a full day", () => {
  assert.isFalse(isEventLogFloorPinned(null, NOW_MS));
  assert.isFalse(isEventLogFloorPinned(NOW_MS - EVENT_LOG_FLOOR_PINNED_WARN_MS + 1, NOW_MS));
  assert.isTrue(isEventLogFloorPinned(NOW_MS - EVENT_LOG_FLOOR_PINNED_WARN_MS, NOW_MS));
});

it.effect("an open intent of a blocked plan no longer holds the floor", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedCompactableLog(sql, { count: 1_000, receipts: false });
    let floor = yield* floorAt(sql);
    assert.deepEqual([floor.floor, floor.heldBy, floor.pinnedSinceMs], [900, "hot-window", null]);

    yield* insertOpenIntent(sql, "event-500");
    floor = yield* floorAt(sql);
    assert.deepEqual([floor.floor, floor.heldBy], [499, "cleanup"]);

    // `blocked` is terminal, so neither the plan nor its still-open intent holds history.
    yield* insertPlan(sql, "blocked");
    floor = yield* floorAt(sql);
    assert.deepEqual([floor.floor, floor.heldBy, floor.pinnedSinceMs], [900, "hot-window", null]);
    const [intent] = yield* sql<{ readonly state: string }>`
      SELECT state FROM direct_resource_cleanup_intents WHERE intent_id = 'intent-1'
    `;
    assert.equal(intent?.state, "open", "the floor read never mutates the intent");

    // A plan that can still run keeps holding it.
    yield* sql`UPDATE direct_resource_cleanup_plans SET state = 'retry'`;
    floor = yield* floorAt(sql);
    assert.deepEqual([floor.floor, floor.heldBy], [399, "cleanup"]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("dates a pin from when both hot windows released the held event", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Every seeded event occurred three days before NOW_MS.
    yield* seedCompactableLog(sql, { count: 1_000, receipts: false });
    yield* insertOpenIntent(sql, "event-500");
    const floor = yield* floorAt(sql);
    const occurredAt = NOW_MS - 3 * DAY_MS;
    assert.equal(floor.pinnedSinceMs, occurredAt + TEST_HOT_WINDOW.ms);
    assert.isTrue(isEventLogFloorPinned(floor.pinnedSinceMs, NOW_MS));

    // Read before the held event left the time window: not pinned yet.
    const early = yield* floorAt(sql, occurredAt + TEST_HOT_WINDOW.ms - 1);
    assert.isNull(early.pinnedSinceMs);

    // An organization undo is bounded, so it is never reported as pinned.
    yield* sql`DELETE FROM direct_resource_cleanup_intents`;
    yield* sql`
      INSERT INTO thread_organization_operations (operation_id, occurrence_id, attempt, thread_id,
        payload_digest, payload_json, created_at_ms, status, outcome_json)
      VALUES ('command-700', 'occurrence-1', 0, 'thread-1', 'digest', '{}', ${NOW_MS},
        'prepared', NULL)
    `;
    const organization = yield* floorAt(sql);
    assert.deepEqual([organization.heldBy, organization.pinnedSinceMs], ["organization", null]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("reports a floor held by an old verified baseline as pinned", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Events are three days old; the newest verified baseline covers only the first 500.
    const range = yield* seedCompactableLog(sql, { count: 1_000, receipts: false });
    yield* verifyBaselineThrough(sql, range.start + 499);
    yield* sql`DELETE FROM projection_baselines WHERE sequence > ${range.start + 499}`;
    const floor = yield* floorAt(sql);
    assert.deepEqual([floor.floor, floor.heldBy], [range.start + 499, "baseline"]);
    assert.isTrue(isEventLogFloorPinned(floor.pinnedSinceMs, NOW_MS));
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("reports a pinned floor in progress at backlog 0, and again after a restart", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const range = yield* seedCompactableLog(sql, { count: 1_000, receipts: false });
    const make = () =>
      makeEventLogMaintenance({
        now: () => NOW_MS,
        readSignals: () => Effect.succeed(IDLE_SIGNALS),
        floorInputs: () => ({ reactorCursor: null, deliveryAcknowledged: null }),
        hotWindow: TEST_HOT_WINDOW,
      });
    // A stuck intent holds event 500; maintenance drains everything below it, then reads idle.
    yield* insertOpenIntent(sql, `event-${range.start + 499}`);
    const first = yield* make();
    for (let tick = 0; tick < 20; tick += 1) {
      if ((yield* first.service.runTick).drained) break;
    }
    const progress = yield* first.service.progress;
    assert.equal(progress.backlogSequences, 0);
    assert.equal(progress.state, "idle");
    assert.deepEqual([progress.floorHeldBy, progress.floorPinned], ["cleanup", true]);
    assert.isNotNull(progress.floorPinnedSince);

    // Nothing is stored for it: a new process re-derives the pin on its first tick.
    const second = yield* make();
    yield* second.service.runTick;
    assert.isTrue((yield* second.service.progress).floorPinned);

    yield* insertPlan(sql, "blocked");
    yield* second.service.runTick;
    assert.isFalse((yield* second.service.progress).floorPinned);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
