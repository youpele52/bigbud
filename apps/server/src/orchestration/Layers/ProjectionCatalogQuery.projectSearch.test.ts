import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionCatalogQuery } from "../Services/ProjectionCatalogQuery.ts";
import { ProjectionCatalogQueryLive } from "./ProjectionCatalogQuery.ts";

const layer = it.layer(
  ProjectionCatalogQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionCatalogQuery project search", (it) => {
  it.effect("matches project names literally across paged local catalogs", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionCatalogQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_execution_target_id, workspace_root, scripts_json,
          created_at, updated_at, last_used_at, deleting_at, deleted_at
        ) VALUES
          ('project-new', 'Bigbud% New', 'local', '/new', '[]',
           '2026-01-01', '2026-01-01', '2026-01-03', NULL, NULL),
          ('project-old', 'bigbud% Old', 'local', '/old', '[]',
           '2026-01-01', '2026-01-01', '2026-01-02', NULL, NULL),
          ('project-unrelated', 'Other', 'local', '/other', '[]',
           '2026-01-01', '2026-01-01', '2026-01-01', NULL, NULL),
          ('project-deleting', 'Bigbud% deleting', 'local', '/deleting', '[]',
           '2026-01-01', '2026-01-01', '2026-01-04', '2026-01-04', NULL),
          ('project-remote', 'Bigbud% remote', 'ssh:workspace', '/remote', '[]',
           '2026-01-01', '2026-01-01', '2026-01-05', NULL, NULL)
      `;

      const first = yield* query.getStartupProjectCatalog({
        scope: "local",
        query: "BIGBUD%",
        limit: 1,
      });
      assert.deepEqual(
        first.projects.map((project) => project.id),
        ["project-new"],
      );
      assert.equal(first.remainingCount, 1);

      const second = yield* query.getStartupProjectCatalog({
        scope: "local",
        query: "BIGBUD%",
        limit: 1,
        cursor: first.nextCursor,
      });
      assert.deepEqual(
        second.projects.map((project) => project.id),
        ["project-old"],
      );
      assert.equal(second.remainingCount, 0);

      const remote = yield* query.getStartupProjectCatalog({
        scope: "remote",
        query: "bigbud%",
      });
      assert.deepEqual(
        remote.projects.map((project) => project.id),
        ["project-remote"],
      );
    }),
  );
});
