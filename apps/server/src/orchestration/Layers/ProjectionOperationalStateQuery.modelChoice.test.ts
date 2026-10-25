import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionOperationalStateQuery } from "../Services/ProjectionOperationalStateQuery.ts";
import { ProjectionOperationalStateQueryLive } from "./ProjectionOperationalStateQuery.ts";
import { unresolvedModelChoiceRequestsCtes } from "../../persistence/DelegatedModelChoiceSql.ts";
import { startupActivityWindowStatement } from "./ProjectionOperationalStateQuery.sql.ts";

const layer = it.layer(
  ProjectionOperationalStateQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

/** An idle tributary held on a model choice, buried under 120 later activities. */
function seedHeldThread(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json, scripts_json,
        created_at, updated_at, deleted_at
      ) VALUES ('project-held', 'Held', '/tmp/held', '{"provider":"codex","model":"gpt-5"}',
        '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, latest_turn_id,
        created_at, updated_at, deleted_at, pinned_at
      ) VALUES
        ('thread-held', 'project-held', 'Held', '{"provider":"codex","model":"gpt-5"}', NULL,
         '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z', NULL,
         '2026-01-01T00:00:01.000Z'),
        ('thread-resolved', 'project-held', 'Resolved', '{"provider":"codex","model":"gpt-5"}',
         NULL, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z', NULL,
         '2026-01-01T00:00:01.000Z')
    `;
    yield* sql`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
      ) VALUES
        ('held-requested', 'thread-held', NULL, 'info', 'delegation.model-choice-requested',
         'Choose', '{"choiceId":"choice-held"}', 0, '2026-01-01T00:00:01.000Z'),
        ('resolved-requested', 'thread-resolved', NULL, 'info',
         'delegation.model-choice-requested', 'Choose', '{"choiceId":"choice-done"}', 0,
         '2026-01-01T00:00:01.000Z'),
        ('resolved-resolved', 'thread-resolved', NULL, 'info',
         'delegation.model-choice-resolved', 'Chosen', '{"choiceId":"choice-done"}', 1,
         '2026-01-01T00:00:02.000Z')
    `;
    yield* sql`
      WITH RECURSIVE counter(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM counter WHERE value < 120
      )
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
      )
      SELECT 'held-note-' || printf('%03d', value), 'thread-held', NULL, 'info', 'runtime.note',
        'note', '{}', value, strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || value || ' minutes')
      FROM counter
    `;
  });
}

layer("operational state keeps unresolved delegated model choices (H1)", (it) => {
  it.effect("loads the held choice at startup and in the bounded per-thread window", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionOperationalStateQuery;
      yield* seedHeldThread(yield* SqlClient.SqlClient);

      const startup = yield* query.getStartupOperationalState();
      const held = startup.threads.find((thread) => thread.id === "thread-held");
      assert.isTrue(held?.activities.some((activity) => activity.id === "held-requested"));
      const resolved = startup.threads.find((thread) => thread.id === "thread-resolved");
      assert.equal(resolved?.activities.length, 0);

      const operational = yield* query.getThreadOperationalState(
        ThreadId.makeUnsafe("thread-held"),
      );
      assert(Option.isSome(operational));
      const activities = operational.value.threads[0]!.activities;
      assert.equal(activities.length, 101);
      assert.equal(activities[0]?.id, "held-requested");
    }),
  );

  it.effect("keeps a hold whose choice id was resolved only on another thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionOperationalStateQuery;
      // thread-resolved resolved "choice-done"; thread-held's "choice-held" stays unresolved even
      // when another thread resolves the same id.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES ('foreign-resolved', 'thread-resolved', NULL, 'info',
          'delegation.model-choice-resolved', 'Chosen', '{"choiceId":"choice-held"}', 2,
          '2026-01-01T00:00:03.000Z')
      `;
      const startup = yield* query.getStartupOperationalState();
      const held = startup.threads.find((thread) => thread.id === "thread-held");
      assert.isTrue(held?.activities.some((activity) => activity.id === "held-requested"));
    }),
  );

  // Review fix #1: the held set is computed once; no correlated activity lookup per row.
  it.effect("plans the startup window without a correlated activity subquery", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [text, params] = startupActivityWindowStatement(sql).compile();
      const plan = yield* sql.unsafe<{ id: number; parent: number; detail: string }>(
        `EXPLAIN QUERY PLAN ${text}`,
        params,
      );
      const correlated = new Set(
        plan.filter((row) => row.detail.startsWith("CORRELATED")).map((row) => row.id),
      );
      for (const row of plan) {
        if (correlated.has(row.parent)) {
          assert.notInclude(row.detail, "projection_thread_activities");
        }
      }
      assert.isTrue(plan.some((row) => row.detail.includes("MATERIALIZE model_choice_unresolved")));
    }),
  );

  // A lazy thread load must not scan every model-choice activity in the database: the
  // materialized CTEs are scoped to the thread and searched through a thread_id index.
  it.effect("scopes the per-thread model-choice CTEs to the loaded thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [text, params] = sql`
        WITH ${unresolvedModelChoiceRequestsCtes(sql, "thread-held")}
        SELECT activity_id FROM model_choice_unresolved
      `.compile();
      const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${text}`, params);
      const activityReads = plan.filter((row) =>
        /^(SCAN|SEARCH) (projection_thread_activities|requested)\b/.test(row.detail),
      );
      assert.isAbove(activityReads.length, 0);
      for (const row of activityReads) assert.include(row.detail, "thread_id=?");
    }),
  );
});
