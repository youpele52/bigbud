import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PROJECTION_BASELINE_TABLES,
  PROJECTION_BASELINE_THREAD_OWNED_TABLES,
} from "../ProjectionBaselineSchema.ts";
import { ProjectionBaselineRepository } from "../Services/ProjectionBaselines.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionBaselineRepositoryLive } from "./ProjectionBaselines.ts";
import {
  type BaselinePayload,
  sanitizeLegacyThreadOwnedRows,
} from "./ProjectionBaselines.payload.ts";
import { deleteMissingRows } from "./ProjectionBaselines.restore.ts";
import { insertProjectionThreadParent } from "./ProjectionThread.test.helpers.ts";

const layer = it.layer(
  Layer.fresh(ProjectionBaselineRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
);

function emptyPayload(): BaselinePayload {
  return {
    tables: Object.fromEntries(PROJECTION_BASELINE_TABLES.map((table) => [table, []])),
  };
}

it("filters every thread-owned baseline table and reports only bounded table counts", () => {
  const payload = emptyPayload();
  payload.tables.projection_threads = [{ thread_id: "valid-thread" }];
  for (const table of PROJECTION_BASELINE_THREAD_OWNED_TABLES) {
    payload.tables[table] = [
      { thread_id: "valid-thread", value: `valid-${table}` },
      { thread_id: "legacy-orphan", value: `orphan-${table}` },
    ];
  }

  const result = sanitizeLegacyThreadOwnedRows(payload);
  for (const table of PROJECTION_BASELINE_THREAD_OWNED_TABLES) {
    assert.deepEqual(result.payload.tables[table], [
      { thread_id: "valid-thread", value: `valid-${table}` },
    ]);
  }
  assert.equal(result.sanitization.length, PROJECTION_BASELINE_THREAD_OWNED_TABLES.length);
  assert.isTrue(result.sanitization.every((entry) => entry.removedCount === 1));
  assert.isTrue(
    result.sanitization.every(
      (entry) => Object.keys(entry).toSorted().join(",") === "removedCount,table",
    ),
  );
  const metadata = JSON.stringify(result.sanitization);
  assert.notInclude(metadata, "valid-thread");
  assert.notInclude(metadata, "legacy-orphan");
  assert.notInclude(metadata, "orphan-");
});

layer("legacy projection baseline restore", (it) => {
  it.effect(
    "restores valid rows, drops an orphan session, and permits a new verified baseline",
    () =>
      Effect.gen(function* () {
        const baselines = yield* ProjectionBaselineRepository;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("legacy-valid-thread");
        yield* insertProjectionThreadParent({ sql, threadId });
        yield* sql`
        INSERT INTO projection_thread_sessions (thread_id, status, updated_at)
        VALUES (${threadId}, 'ready', '2026-09-03T00:00:00.000Z')
      `;
        const payload = JSON.parse(yield* baselines.capturePayload()) as BaselinePayload;
        const validSession = payload.tables.projection_thread_sessions![0]!;
        payload.tables.projection_thread_sessions = [
          validSession,
          { ...validSession, thread_id: "legacy-orphan-session" },
        ];

        yield* baselines.restorePayload(JSON.stringify(payload), 0, []);
        const sessions = yield* sql<{ readonly threadId: string; readonly status: string }>`
        SELECT thread_id AS "threadId", status FROM projection_thread_sessions
      `;
        assert.deepEqual(sessions, [{ threadId, status: "ready" }]);

        const candidate = yield* baselines.createCandidate([]);
        assert.isTrue(Option.isSome(candidate));
        if (Option.isSome(candidate)) {
          yield* baselines.markVerified(candidate.value.baselineId, 0, "2026-09-03T00:00:01.000Z");
        }
        assert.isTrue(Option.isSome(yield* baselines.latestVerified()));
      }),
  );

  it.effect("preserves operational rows while reconciling retained project and thread rows", () =>
    Effect.gen(function* () {
      const baselines = yield* ProjectionBaselineRepository;
      const sql = yield* SqlClient.SqlClient;
      const projectId = "baseline-operational-project";
      const threadId = ThreadId.makeUnsafe("baseline-operational-thread");
      const childThreadId = ThreadId.makeUnsafe("baseline-operational-child");
      const now = "2026-09-03T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, execution_target_id, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (${projectId}, 'Original project', 'local', '/tmp/project', '[]', ${now}, ${now})
      `;
      yield* insertProjectionThreadParent({ sql, threadId, projectId, createdAt: now });
      yield* insertProjectionThreadParent({
        sql,
        threadId: childThreadId,
        projectId,
        createdAt: now,
      });
      yield* sql`
        INSERT INTO automation_schedules (
          automation_id, project_id, target_thread_id, title, prompt, cron_expression,
          timezone, created_at, updated_at
        ) VALUES ('baseline-schedule', ${projectId}, ${threadId}, 'Schedule', 'Prompt', '* * * * *',
          'UTC', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO orchestration_bootstrap_recipes (
          parent_command_id, recipe_version, project_id, project_cwd, base_branch, created_at
        ) VALUES ('baseline-recipe', 'bootstrap/v1', ${projectId}, '/tmp/project', 'main', ${now})
      `;
      yield* sql`
        INSERT INTO remote_agent_restart_requests (
          request_id, project_id, target_id, route_json, phase, updated_at
        ) VALUES ('baseline-restart', ${projectId}, 'target', '{}', 'queued', 1)
      `;
      yield* sql`
        INSERT INTO thread_delegations (
          delegation_id, caller_thread_id, source_message_id, invocation_id, root_delegation_id,
          depth, target_kind, target_project_id, child_thread_id, child_turn_id, created_project_id,
          state, created_at, updated_at
        ) VALUES ('baseline-delegation', ${threadId}, 'message', 'invocation', 'baseline-delegation',
          0, 'project', ${projectId}, ${childThreadId}, 'turn', ${projectId}, 'reserved', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO projection_thread_watches (
          watch_id, watcher_thread_id, watched_thread_id, watched_thread_title,
          source_message_id, status, created_at
        ) VALUES
          ('baseline-active-watch', ${threadId}, ${childThreadId}, 'Child', 'source-active', 'active', ${now}),
          ('baseline-completed-watch', ${threadId}, ${childThreadId}, 'Child', 'source-completed', 'completed', ${now})
      `;

      const payload = yield* baselines.capturePayload();
      yield* sql`UPDATE projection_projects SET title = 'Changed project' WHERE project_id = ${projectId}`;
      yield* sql`UPDATE projection_threads SET title = 'Changed thread' WHERE thread_id = ${threadId}`;
      yield* baselines.restorePayload(payload, 0, []);

      assert.deepEqual(
        yield* sql`SELECT title FROM projection_projects WHERE project_id = ${projectId}`,
        [{ title: "Original project" }],
      );
      assert.deepEqual(
        yield* sql`SELECT title FROM projection_threads WHERE thread_id = ${threadId}`,
        [{ title: "Fixture thread" }],
      );
      assert.deepEqual(
        yield* sql`SELECT automation_id, project_id, target_thread_id FROM automation_schedules`,
        [{ automation_id: "baseline-schedule", project_id: projectId, target_thread_id: threadId }],
      );
      assert.deepEqual(
        yield* sql`SELECT parent_command_id, project_id FROM orchestration_bootstrap_recipes`,
        [{ parent_command_id: "baseline-recipe", project_id: projectId }],
      );
      assert.deepEqual(
        yield* sql`SELECT request_id, project_id FROM remote_agent_restart_requests`,
        [{ request_id: "baseline-restart", project_id: projectId }],
      );
      assert.deepEqual(
        yield* sql`SELECT delegation_id, target_project_id, created_project_id FROM thread_delegations`,
        [
          {
            delegation_id: "baseline-delegation",
            target_project_id: projectId,
            created_project_id: projectId,
          },
        ],
      );
      assert.deepEqual(
        yield* sql`SELECT watch_id, status FROM projection_thread_watches ORDER BY watch_id`,
        [
          { watch_id: "baseline-active-watch", status: "active" },
          { watch_id: "baseline-completed-watch", status: "completed" },
        ],
      );
    }),
  );

  it.effect("deletes large baseline key sets with one bounded SQLite value", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TEMP TABLE baseline_large_keys (key_a TEXT NOT NULL, key_b INTEGER NOT NULL, PRIMARY KEY (key_a, key_b))`;
      yield* sql`
        WITH RECURSIVE numbers(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 1200
        )
        INSERT INTO baseline_large_keys (key_a, key_b)
        SELECT 'row-' || value, value FROM numbers
      `;
      const payloadRows = Array.from({ length: 1200 }, (_, index) => ({
        key_a: `row-${index + 1}`,
        key_b: index + 1,
      }));
      const deletion = deleteMissingRows(
        "baseline_large_keys",
        [
          { name: "key_a", primaryKeyPosition: 1, defaultValue: null },
          { name: "key_b", primaryKeyPosition: 2, defaultValue: null },
        ],
        payloadRows,
      );
      assert.equal(deletion.params.length, 1);
      const queryPlan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${deletion.statement}`,
        deletion.params,
      );
      assert.isFalse(queryPlan.some((row) => row.detail.includes("CORRELATED")));
      assert.isTrue(queryPlan.some((row) => row.detail.includes("LIST SUBQUERY")));
      yield* sql.unsafe(deletion.statement, deletion.params);
      assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM baseline_large_keys`, [
        { count: 1200 },
      ]);
    }),
  );

  it.effect("retains composite primary keys with null components", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TEMP TABLE baseline_nullable_keys (key_a TEXT, key_b TEXT, PRIMARY KEY (key_a, key_b))`;
      yield* sql`INSERT INTO baseline_nullable_keys (key_a, key_b) VALUES
        ('keep-a', NULL), (NULL, 'keep-b'), ('remove-a', NULL), (NULL, 'remove-b'), (NULL, NULL)`;
      const deletion = deleteMissingRows(
        "baseline_nullable_keys",
        [
          { name: "key_a", primaryKeyPosition: 1, defaultValue: null },
          { name: "key_b", primaryKeyPosition: 2, defaultValue: null },
        ],
        [
          { key_a: "keep-a", key_b: null },
          { key_a: null, key_b: "keep-b" },
        ],
      );
      yield* sql.unsafe(deletion.statement, deletion.params);
      assert.deepEqual(yield* sql`SELECT key_a, key_b FROM baseline_nullable_keys`, [
        { key_a: "keep-a", key_b: null },
        { key_a: null, key_b: "keep-b" },
      ]);
    }),
  );

  it.effect("rejects malformed owned rows instead of treating them as legacy orphans", () =>
    Effect.gen(function* () {
      const baselines = yield* ProjectionBaselineRepository;
      const payload = emptyPayload();
      payload.tables.projection_thread_sessions = [{ status: "ready" }];
      assert.equal(
        (yield* Effect.exit(baselines.restorePayload(JSON.stringify(payload), 0, [])))._tag,
        "Failure",
      );
    }),
  );

  it.effect("preserves unrelated integrity failures", () =>
    Effect.gen(function* () {
      const baselines = yield* ProjectionBaselineRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("duplicate-session-thread");
      yield* insertProjectionThreadParent({ sql, threadId });
      yield* sql`
        INSERT INTO projection_thread_sessions (thread_id, status, updated_at)
        VALUES (${threadId}, 'ready', '2026-09-03T00:00:00.000Z')
      `;
      const payload = JSON.parse(yield* baselines.capturePayload()) as BaselinePayload;
      payload.tables.projection_thread_sessions = [
        payload.tables.projection_thread_sessions![0]!,
        payload.tables.projection_thread_sessions![0]!,
      ];
      assert.equal(
        (yield* Effect.exit(baselines.restorePayload(JSON.stringify(payload), 0, [])))._tag,
        "Failure",
      );
    }),
  );
});
