import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionCatalogQuery } from "../Services/ProjectionCatalogQuery.ts";
import { ProjectionCatalogQueryLive } from "./ProjectionCatalogQuery.ts";

const layer = it.layer(
  ProjectionCatalogQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const projectId = ProjectId.makeUnsafe("project-counts");

layer("ProjectionCatalogQuery active project thread counts", (it) => {
  it.effect("matches project summaries, active pages, agent lists, and sidebar refreshes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionCatalogQuery;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at,
          last_used_at, deleting_at, deleted_at
        ) VALUES (
          'project-counts', 'Counted project', '/counts', '[]', '2026-08-01',
          '2026-08-01', '2026-08-01', NULL, NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, archived_at, deleting_at, deleted_at
        ) VALUES
          ('caller', 'project-counts', 'Caller', 'standard',
           '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default',
           '2026-08-01', '2026-08-06', NULL, NULL, NULL),
          ('active', 'project-counts', 'Active', 'standard',
           '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default',
           '2026-08-01', '2026-08-05', NULL, NULL, NULL),
          ('deleting', 'project-counts', 'Deleting', 'standard',
           '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default',
           '2026-08-01', '2026-08-04', NULL, '2026-08-04', NULL),
          ('archived', 'project-counts', 'Archived', 'standard',
           '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default',
           '2026-08-01', '2026-08-03', '2026-08-03', NULL, NULL),
          ('deleted', 'project-counts', 'Deleted', 'standard',
           '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default',
           '2026-08-01', '2026-08-02', NULL, NULL, '2026-08-02'),
          ('side-chat', 'project-counts', 'Side chat', 'side-chat',
           '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default',
           '2026-08-01', '2026-08-01', NULL, NULL, NULL)
      `;

      const projectCatalog = yield* query.getStartupProjectCatalog({ limit: 1 });
      const threadPage = yield* query.getProjectThreadSummaries({
        projectId,
        limit: 20,
      });
      const agentList = yield* query.listThreads({
        callerThreadId: ThreadId.makeUnsafe("caller"),
        status: "active",
        limit: 20,
        includeExcerpt: false,
      });
      const sidebarCatalog = yield* query.getSidebarThreadCatalog();

      assert.equal(projectCatalog.projects[0]?.threadCount, 2);
      assert.deepEqual(
        threadPage.threads.map((thread) => thread.id),
        ["caller", "active"],
      );
      assert.equal(agentList.totalCount, 2);
      assert.deepEqual(
        agentList.threads.map((thread) => thread.threadId),
        ["caller", "active"],
      );
      assert.deepEqual(sidebarCatalog.projectThreadCounts, [{ projectId, threadCount: 2 }]);
    }),
  );
});
