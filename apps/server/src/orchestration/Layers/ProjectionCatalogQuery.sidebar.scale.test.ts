import { BUILT_IN_CHATS_PROJECT_ID } from "@bigbud/contracts/constants/project.constant.ts";
import { ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { performance } from "node:perf_hooks";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionCatalogQuery } from "../Services/ProjectionCatalogQuery.ts";
import { ProjectionCatalogQueryLive } from "./ProjectionCatalogQuery.ts";

const layer = it.layer(
  ProjectionCatalogQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const THREAD_COUNT = 10_000;
const PROJECT_COUNT = 50;
/** Fixed budget per read; measured reads are a few milliseconds, the margin absorbs slow CI. */
const READ_BUDGET_MS = 150;

const time = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    // Warm the statement cache so the budget measures the query, not preparation.
    yield* effect;
    const startedAt = performance.now();
    const value = yield* effect;
    return { value, elapsedMs: performance.now() - startedAt };
  });

layer("ProjectionCatalogQuery sidebar at scale", (it) => {
  it.effect(
    "serves the sidebar catalog, project stats and pages for 10,000 threads within budget",
    () =>
      Effect.gen(function* () {
        const query = yield* ProjectionCatalogQuery;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          WITH RECURSIVE sequence(value) AS (
            SELECT 0 UNION ALL SELECT value + 1 FROM sequence WHERE value < ${PROJECT_COUNT - 1}
          )
          INSERT INTO projection_projects (
            project_id, title, workspace_root, scripts_json, created_at, updated_at, last_used_at
          )
          SELECT printf('scale-project-%02d', value), printf('Project %d', value),
            printf('/scale/%02d', value), '[]', '2026-01-01', '2026-01-01',
            printf('2026-01-%02d', 1 + value % 28)
          FROM sequence
        `;
        // A fifth of the threads are Chats; the rest spread across projects.
        yield* sql`
          WITH RECURSIVE sequence(value) AS (
            SELECT 0 UNION ALL SELECT value + 1 FROM sequence WHERE value < ${THREAD_COUNT - 1}
          )
          INSERT INTO projection_threads (
            thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
            interaction_mode, created_at, updated_at, archived_at, deleted_at, pinned_at
          )
          SELECT printf('scale-thread-%05d', value),
            CASE WHEN value % 5 = 0 THEN ${BUILT_IN_CHATS_PROJECT_ID}
              ELSE printf('scale-project-%02d', value % ${PROJECT_COUNT}) END,
            printf('Thread %d', value), 'standard', '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access', 'default', printf('2026-02-%02dT%05d', 1 + value % 28, value),
            '2026-03-01', NULL, NULL,
            CASE WHEN value % 997 = 0 THEN '2026-03-02' ELSE NULL END
          FROM sequence
        `;
        // Every other thread has user messages (kept in `latest_user_message_at` by trigger).
        yield* sql`
          WITH RECURSIVE sequence(value) AS (
            SELECT 0 UNION ALL SELECT value + 1 FROM sequence WHERE value < ${THREAD_COUNT * 2 - 1}
          )
          INSERT INTO projection_thread_messages (
            message_id, thread_id, role, text, is_streaming, created_at, updated_at
          )
          SELECT printf('scale-message-%06d', value), printf('scale-thread-%05d', value / 2),
            CASE WHEN (value / 2) % 2 = 0 THEN 'user' ELSE 'assistant' END, 'hello', 0,
            printf('2026-03-%02dT%06d', 1 + value % 28, value), '2026-03-01'
          FROM sequence
        `;

        const catalog = yield* time(query.getSidebarThreadCatalog());
        const projects = yield* time(query.getStartupProjectCatalog({ scope: "local", limit: 20 }));
        const page = yield* time(
          query.getProjectThreadSummaries({
            projectId: ProjectId.makeUnsafe("scale-project-01"),
            limit: 4,
            sortOrder: "updated_at",
          }),
        );

        assert.isAtLeast(catalog.value.recentThreadIds.length, 1);
        assert.isAtMost(catalog.value.threads.length, 30);
        const counted = catalog.value.projectThreadCounts ?? [];
        // The built-in Chats project is a project row too, so every live thread is counted.
        assert.equal(
          counted.reduce((total, entry) => total + entry.threadCount, 0),
          THREAD_COUNT,
        );
        assert.equal(projects.value.projects.length, 20);
        assert.equal(page.value.threads.length, 4);
        assert.isBelow(catalog.elapsedMs, READ_BUDGET_MS, "sidebar catalog");
        assert.isBelow(projects.elapsedMs, READ_BUDGET_MS, "startup project catalog stats");
        assert.isBelow(page.elapsedMs, READ_BUDGET_MS, "project thread page");
        if (process.env.BIGBUD_SIDEBAR_SCALE_BENCHMARK === "1") {
          process.stdout.write(
            `${JSON.stringify({
              threads: THREAD_COUNT,
              sidebarCatalogMs: catalog.elapsedMs,
              projectCatalogMs: projects.elapsedMs,
              projectPageMs: page.elapsedMs,
            })}\n`,
          );
        }
      }),
    120_000,
  );

  it.effect("reads the sort key from its column, not a per-thread message subquery", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT t.thread_id FROM projection_threads t
        WHERE t.project_id = ${BUILT_IN_CHATS_PROJECT_ID}
          AND t.deleted_at IS NULL AND t.archived_at IS NULL AND t.deleting_at IS NULL
        ORDER BY COALESCE(t.latest_user_message_at, t.created_at) DESC, t.thread_id DESC
        LIMIT 5
      `;
      assert.ok(
        !plan.some((row) => row.detail.includes("projection_thread_messages")),
        JSON.stringify(plan),
      );
    }),
  );
});
