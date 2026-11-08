import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeOrchestrationDomainEventDistribution } from "../../orchestration/Layers/OrchestrationEngine.domainEvents.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { makeEventLogMaintenance } from "./EventLogMaintenance.ts";
import { readEventLogFloor } from "./EventLogMaintenance.floor.ts";
import {
  DAY_MS,
  IDLE_SIGNALS,
  NOW_MS,
  readRetention,
  seedCompactableLog,
  seedEvents,
  setProjectorCursors,
  TEST_HOT_WINDOW,
  verifyBaselineThrough,
} from "./EventLogMaintenance.test.helpers.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const TestLayer = OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

const floorOf = (
  sql: SqlClient.SqlClient,
  inputs: { readonly reactorCursor?: number; readonly deliveryAcknowledged?: number } = {},
  hotWindow: { readonly sequences: number; readonly ms: number } = TEST_HOT_WINDOW,
) =>
  readEventLogFloor(sql, {
    nowMs: NOW_MS,
    reactorCursor: inputs.reactorCursor ?? null,
    deliveryAcknowledged: inputs.deliveryAcknowledged ?? null,
    hotWindow,
  });

it.effect("is the minimum of baseline, projector, reactor, delivery and hot window", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedEvents(sql, { count: 1_000 });
    yield* verifyBaselineThrough(sql, 800);
    yield* setProjectorCursors(sql, 900);
    let floor = yield* floorOf(sql);
    assert.deepEqual([floor.floor, floor.heldBy], [800, "baseline"]);

    yield* setProjectorCursors(sql, 700);
    floor = yield* floorOf(sql);
    assert.deepEqual([floor.floor, floor.heldBy], [700, "projector"]);
    floor = yield* floorOf(sql, { reactorCursor: 600 });
    assert.deepEqual([floor.floor, floor.heldBy], [600, "reactor"]);
    floor = yield* floorOf(sql, { reactorCursor: 600, deliveryAcknowledged: 500 });
    assert.deepEqual([floor.floor, floor.heldBy], [500, "delivery"]);

    // The newest 100 sequences stay; every event is older than the 60-second window.
    yield* verifyBaselineThrough(sql, 1_000);
    yield* setProjectorCursors(sql, 1_000);
    floor = yield* floorOf(sql);
    assert.deepEqual([floor.floor, floor.heldBy], [900, "hot-window"]);

    // With a 1-day window, 500 events from the last hour keep more than 100 sequences do.
    yield* seedEvents(sql, { count: 500, ageMs: 60 * 60_000 });
    yield* verifyBaselineThrough(sql, 1_500);
    yield* setProjectorCursors(sql, 1_500);
    floor = yield* floorOf(sql, {}, { sequences: 100, ms: DAY_MS });
    assert.deepEqual([floor.floor, floor.heldBy], [1_000, "hot-window"]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("holds below events referenced by recovery work, and releases them when done", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedCompactableLog(sql, { count: 1_000, receipts: false });
    const now = new Date(NOW_MS).toISOString();
    const expect = (value: number, holder: string) =>
      floorOf(sql).pipe(
        Effect.map((floor) => assert.deepEqual([floor.floor, floor.heldBy], [value, holder])),
      );
    yield* expect(900, "hot-window");

    yield* sql`
      INSERT INTO worktree_operations (operation_id, request_digest, kind, repository, cwd,
        source_path, destination_path, canonical_path, device, inode, branch, phase, created_at)
      VALUES ('op-1', 'digest', 'rename', '/repo', '/repo', '/old', '/new', '/old', 1, 2,
        'main', 'prepared', ${now})
    `;
    yield* sql`
      INSERT INTO worktree_operation_items (operation_id, thread_id, old_path, new_path, command_id)
      VALUES ('op-1', 'thread-1', '/old', '/new', 'command-850')
    `;
    yield* expect(849, "workspace");
    yield* sql`
      INSERT INTO project_workspace_native_operations (operation_id, command_id, project_id,
        request_json, source_path, destination_path, phase, steps_json, created_at, updated_at)
      VALUES ('op-1', 'command-800', 'project-native', '{}', '/old', '/new', 'prepared', '[]', ${now}, ${now})
    `;
    yield* expect(799, "workspace");

    yield* sql`
      INSERT INTO thread_organization_operations (operation_id, occurrence_id, attempt, thread_id,
        payload_digest, payload_json, created_at_ms, status, outcome_json)
      VALUES ('command-700', 'occurrence-1', 0, 'thread-1', 'digest', '{}', ${NOW_MS}, 'prepared', NULL),
        ('command-650', 'occurrence-2', 0, 'thread-2', 'digest', '{}', ${NOW_MS - 8 * DAY_MS},
          'applied', '{}')
    `;
    yield* expect(699, "organization");
    // An automatic move outside the 7-day undo window does not hold the floor.
    yield* sql`
      INSERT INTO thread_organization_runtime_threads (thread_id, fact_version, source_frontier,
        transition_digest, attention_watermark, latest_automatic_move_id)
      VALUES ('thread-2', 1, 0, 'digest', 0, 'command-650')
    `;
    yield* expect(699, "organization");
    yield* sql`UPDATE thread_organization_operations SET created_at_ms = ${NOW_MS}
      WHERE operation_id = 'command-650'`;
    yield* expect(649, "organization");

    yield* sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project', 'Project', '/tmp/project', '[]', ${now}, ${now})
    `;
    yield* sql`
      INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json,
        runtime_mode, interaction_mode, created_at, updated_at, pending_turn_start_json)
      VALUES ('thread-1', 'project', 'Thread', '{"provider":"codex","model":"gpt-5.4"}',
        'full-access', 'default', ${now}, ${now},
        ${JSON.stringify({ messageId: "message-1", requestedAt: now, requestedSequence: 600 })})
    `;
    yield* expect(599, "turn-start");

    yield* sql`
      INSERT INTO direct_resource_cleanup_intents (intent_id, event_id, source_command_id,
        source_payload_digest_version, source_payload_digest, entity_kind, entity_id,
        deletion_mode, deletion_requested_at, state)
      VALUES ('intent-1', 'event-500', 'command-500', 'v1', 'digest', 'thread', 'thread-1',
        'single', ${now}, 'open')
    `;
    yield* expect(499, "cleanup");
    yield* sql`
      INSERT INTO direct_resource_cleanup_plans (operation_id, intent_id, finalize_command_id,
        finalize_payload_json, finalize_payload_digest_version, finalize_payload_digest,
        plan_digest, expected_platform, state, created_at, updated_at)
      VALUES ('plan-1', 'intent-1', 'command-400', '{}', 'v1', 'digest', 'plan', 'darwin/arm64',
        'ready', ${now}, ${now})
    `;
    yield* expect(399, "cleanup");

    // Finished recovery work releases the floor again.
    yield* sql`UPDATE direct_resource_cleanup_plans SET state = 'completed', completed_at = ${now}`;
    yield* sql`UPDATE direct_resource_cleanup_intents SET state = 'completed', closed_at = ${now}`;
    yield* sql`UPDATE projection_threads SET pending_turn_start_json = NULL`;
    yield* sql`UPDATE thread_organization_runtime_threads SET latest_automatic_move_id = NULL`;
    yield* sql`UPDATE thread_organization_operations SET status = 'applied', outcome_json = '{}'`;
    yield* sql`UPDATE project_workspace_native_operations SET phase = 'committed'`;
    yield* sql`UPDATE worktree_operations SET phase = 'completed'`;
    yield* expect(900, "hot-window");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("a lagging reactor holds compaction back, and its stream never sees a gap", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const eventStore = yield* OrchestrationEventStore;
      yield* seedCompactableLog(sql, { count: 1_000, receipts: false });
      const distribution = yield* makeOrchestrationDomainEventDistribution({
        initialSequence: () => 300,
        readReplay: eventStore.readReplay,
      });
      assert.equal(distribution.oldestOpenCursor(), null);
      const reactor = yield* distribution
        .streamGeneral()
        .pipe(Stream.take(700), Stream.runCollect, Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.equal(distribution.oldestOpenCursor(), 300);

      const maintenance = yield* makeEventLogMaintenance({
        now: () => NOW_MS,
        readSignals: () => Effect.succeed(IDLE_SIGNALS),
        floorInputs: () => ({
          reactorCursor: distribution.oldestOpenCursor(),
          deliveryAcknowledged: null,
        }),
        hotWindow: TEST_HOT_WINDOW,
      });
      for (let tick = 0; tick < 20; tick += 1) {
        if ((yield* maintenance.service.runTick).drained) break;
      }
      assert.equal((yield* readRetention(sql)).retained, 300);
      assert.equal((yield* maintenance.service.progress).floorHeldBy, "reactor");

      // Waking the reactor replays 301..1000 from its cursor; a gap would kill the stream.
      const [lastEvent] = yield* eventStore.readFromSequence(999, 1).pipe(Stream.runCollect);
      yield* distribution.publish(lastEvent!);
      const received = Array.from(yield* Fiber.join(reactor));
      assert.equal(received.length, 700);
      assert.equal(received[0]?.sequence, 301);
      assert.equal(received.at(-1)?.sequence, 1_000);
    }),
  ).pipe(Effect.provide(TestLayer)),
);
