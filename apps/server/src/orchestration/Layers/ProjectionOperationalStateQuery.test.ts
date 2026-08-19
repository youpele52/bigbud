import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionOperationalStateQuery } from "../Services/ProjectionOperationalStateQuery.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { ProjectionOperationalStateQueryLive } from "./ProjectionOperationalStateQuery.ts";

const operationalStateLayer = it.layer(
  ProjectionOperationalStateQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

function seedOperationalFixture(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    yield* sql`DELETE FROM projection_thread_watches`;
    yield* sql`DELETE FROM projection_thread_tasks`;
    yield* sql`DELETE FROM projection_thread_activities`;
    yield* sql`DELETE FROM projection_thread_messages`;
    yield* sql`DELETE FROM projection_thread_proposed_plans`;
    yield* sql`DELETE FROM projection_thread_sessions`;
    yield* sql`DELETE FROM projection_turns`;
    yield* sql`DELETE FROM projection_threads`;
    yield* sql`DELETE FROM projection_projects`;
    yield* sql`DELETE FROM projection_state`;

    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json, scripts_json,
        created_at, updated_at, deleted_at
      ) VALUES (
        'project-operational', 'Operational project', '/tmp/operational',
        '{"provider":"codex","model":"gpt-5-codex"}', '[]',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
      )
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, latest_turn_id,
        created_at, updated_at, deleted_at
      ) VALUES
        ('thread-active', 'project-operational', 'Active',
         '{"provider":"codex","model":"gpt-5-codex"}', 'turn-active',
         '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z', NULL),
        ('thread-inactive', 'project-operational', 'Inactive',
         '{"provider":"codex","model":"gpt-5-codex"}', 'turn-inactive',
          '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z', NULL)
        ,('thread-dormant', 'project-operational', 'Dormant',
          '{"provider":"codex","model":"gpt-5-codex"}', 'turn-dormant',
          '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z', NULL),
        ('thread-pinned', 'project-operational', 'Pinned',
          '{"provider":"codex","model":"gpt-5-codex"}', NULL,
          '2026-01-01T00:00:04.000Z', '2026-01-01T00:00:04.000Z', NULL)
    `;
    yield* sql`
      UPDATE projection_threads
      SET pinned_at = '2026-01-01T00:00:05.000Z'
      WHERE thread_id = 'thread-pinned'
    `;
    yield* sql`
      INSERT INTO projection_thread_sessions (
        thread_id, status, provider_name, runtime_mode, active_turn_id, updated_at
      ) VALUES
        ('thread-active', 'running', 'codex', 'full-access', 'turn-active',
         '2026-01-01T00:10:00.000Z'),
        ('thread-inactive', 'ready', 'codex', 'full-access', NULL,
         '2026-01-01T00:10:01.000Z'),
        ('thread-dormant', 'ready', 'codex', 'full-access', NULL,
         '2026-01-01T00:10:02.000Z')
    `;
    yield* sql`
      WITH RECURSIVE counter(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM counter WHERE value < 60
      )
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
      )
      SELECT
        prefix || '-message-' || printf('%03d', value), thread_id, turn_id, 'assistant',
        prefix || '-message-' || value, 0,
        strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || value || ' seconds'),
        strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || value || ' seconds')
      FROM counter
      CROSS JOIN (
        SELECT 'active' AS prefix, 'thread-active' AS thread_id, 'turn-active' AS turn_id
        UNION ALL
        SELECT 'inactive', 'thread-inactive', 'turn-inactive'
      )
    `;
    yield* sql`
      WITH RECURSIVE counter(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM counter WHERE value < 110
      )
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
      )
      SELECT
        prefix || '-activity-' || printf('%03d', value), thread_id, turn_id,
        'info', 'runtime.note', prefix || '-activity-' || value, '{}', value,
        strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || value || ' seconds')
      FROM counter
      CROSS JOIN (
        SELECT 'active' AS prefix, 'thread-active' AS thread_id, 'turn-active' AS turn_id
        UNION ALL
        SELECT 'inactive', 'thread-inactive', 'turn-inactive'
      )
    `;
    yield* sql`
      INSERT INTO projection_thread_tasks (task_id, thread_id, task_json, created_at, updated_at)
      VALUES (
        'task-active', 'thread-active',
        '{"id":"task-active","status":"inProgress","subject":"Keep running","source":"observed","freshness":{"sessionEpoch":"epoch-1","sourcePriority":1,"observedOrdinal":1},"createdAt":"2026-01-01T00:00:03.000Z","updatedAt":"2026-01-01T00:00:03.000Z"}',
        '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z'
      )
    `;
    yield* sql`
      INSERT INTO projection_thread_proposed_plans (
        plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at
      ) VALUES
        ('plan-active', 'thread-active', 'turn-active', '# Active plan',
         '2026-01-01T00:03:00.000Z', '2026-01-01T00:03:00.000Z'),
        ('plan-inactive', 'thread-inactive', 'turn-inactive', '# Inactive plan',
         '2026-01-01T00:03:01.000Z', '2026-01-01T00:03:01.000Z')
    `;
    yield* sql`
      INSERT INTO projection_turns (
        thread_id, turn_id, state, requested_at, started_at, completed_at,
        checkpoint_turn_count, checkpoint_ref, checkpoint_status, checkpoint_files_json
      ) VALUES
        ('thread-active', 'turn-active', 'running', '2026-01-01T00:04:00.000Z',
         '2026-01-01T00:04:00.000Z', NULL, 1, 'checkpoint-active', 'ready', '[]'),
        ('thread-inactive', 'turn-inactive', 'completed', '2026-01-01T00:04:01.000Z',
          '2026-01-01T00:04:01.000Z', '2026-01-01T00:04:02.000Z',
          1, 'checkpoint-inactive', 'ready', '[]'),
        ('thread-inactive', NULL, 'pending', '2026-01-01T00:04:03.000Z',
          NULL, NULL, NULL, NULL, NULL, '[]'),
        ('thread-dormant', 'turn-dormant', 'completed', '2026-01-01T00:04:04.000Z',
          '2026-01-01T00:04:04.000Z', '2026-01-01T00:04:05.000Z',
          NULL, NULL, NULL, '[]')
    `;
    yield* sql`
      INSERT INTO projection_thread_watches (
        watch_id, watcher_thread_id, watched_thread_id, watched_thread_title,
        source_message_id, status, created_at
      ) VALUES (
        'watch-1', 'thread-active', 'thread-inactive', 'Inactive',
        'active-message-060', 'active', '2026-01-01T00:05:00.000Z'
      )
    `;

    for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES (${projector}, 42, '2026-01-01T00:20:00.000Z')
      `;
    }
  });
}

operationalStateLayer("ProjectionOperationalStateQuery", (it) => {
  it.effect("bounds startup state and reads full single-thread history directly", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionOperationalStateQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* seedOperationalFixture(sql);

      const startup = yield* query.getStartupOperationalState();
      assert.equal(startup.snapshotSequence, 42);
      assert.equal(startup.projects.length, 1);
      assert.equal(startup.threads.length, 3);

      const active = startup.threads.find((thread) => thread.id === "thread-active");
      const inactive = startup.threads.find((thread) => thread.id === "thread-inactive");
      const pinned = startup.threads.find((thread) => thread.id === "thread-pinned");
      assert.isDefined(active);
      assert.isDefined(inactive);
      assert.isDefined(pinned);
      assert.equal(active.messages.length, 50);
      assert.equal(active.messages[0]?.text, "active-message-11");
      assert.equal(active.activities.length, 100);
      assert.equal(active.activities[0]?.summary, "active-activity-11");
      assert.equal(active.proposedPlans.length, 0);
      assert.equal(active.checkpoints.length, 0);
      assert.equal(active.tasks?.length, 1);
      assert.equal(active.session?.status, "running");
      assert.equal(active.latestTurn?.state, "running");
      assert.equal(active.watchingThreads[0]?.threadId, "thread-inactive");
      assert.equal(inactive.messages.length, 0);
      assert.equal(inactive.activities.length, 0);
      assert.equal(inactive.proposedPlans.length, 0);
      assert.equal(inactive.checkpoints.length, 0);
      assert.equal(pinned.messages.length, 0);
      assert.equal(pinned.activities.length, 0);
      assert.equal(pinned.pinnedAt, "2026-01-01T00:00:05.000Z");
      assert.isUndefined(startup.threads.find((thread) => thread.id === "thread-dormant"));

      const operational = yield* query.getThreadOperationalState(
        ThreadId.makeUnsafe("thread-inactive"),
      );
      assert(Option.isSome(operational));
      assert.equal(operational.value.snapshotSequence, 42);
      assert.equal(operational.value.threads[0]?.messages.length, 50);
      assert.equal(operational.value.threads[0]?.activities.length, 100);
      assert.equal(operational.value.threads[0]?.proposedPlans.length, 0);
      assert.equal(operational.value.threads[0]?.checkpoints.length, 0);

      const history = yield* query.getFullThreadHistory(ThreadId.makeUnsafe("thread-inactive"));
      assert(Option.isSome(history));
      assert.equal(history.value.snapshotSequence, 42);
      assert.equal(history.value.projects.length, 1);
      assert.equal(history.value.threads.length, 1);
      assert.equal(history.value.threads[0]?.messages.length, 60);
      assert.equal(history.value.threads[0]?.activities.length, 110);
      assert.equal(history.value.threads[0]?.proposedPlans.length, 1);
      assert.equal(history.value.threads[0]?.checkpoints.length, 1);
      assert.equal(history.value.threads[0]?.latestTurn?.turnId, "turn-inactive");

      const missing = yield* query.getFullThreadHistory(ThreadId.makeUnsafe("missing"));
      assert(Option.isNone(missing));
    }),
  );
});
