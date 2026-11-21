import { BUILT_IN_CHATS_PROJECT_ID } from "@bigbud/contracts/constants/project.constant.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionCatalogQuery } from "../Services/ProjectionCatalogQuery.ts";
import { ProjectionCatalogQueryLive } from "./ProjectionCatalogQuery.ts";

const layer = it.layer(
  ProjectionCatalogQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionCatalogQuery sidebar catalog and Sidecars", (it) => {
  it.effect("never lists a Sidecar opened from a chat as a recent or pinned sidebar thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionCatalogQuery;
      yield* sql`DELETE FROM projection_threads`;
      // A Sidecar inherits its parent's project, so one opened from a chat lives in Chats.
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, pinned_at, archived_at, deleting_at, deleted_at
        ) VALUES
          ('chat', ${BUILT_IN_CHATS_PROJECT_ID}, 'Chat', 'standard',
           '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default',
           '2026-08-01', '2026-08-02', NULL, NULL, NULL, NULL),
          ('sidecar', ${BUILT_IN_CHATS_PROJECT_ID}, 'Sidecar', 'side-chat',
           '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default',
           '2026-08-03', '2026-08-04', NULL, NULL, NULL, NULL),
          ('pinned-sidecar', 'elsewhere', 'Sidecar', 'side-chat',
           '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default',
           '2026-08-03', '2026-08-04', '2026-08-04', NULL, NULL, NULL)
      `;

      const catalog = yield* query.getSidebarThreadCatalog();

      assert.deepEqual(
        catalog.threads.map((thread) => thread.id),
        ["chat"],
      );
      assert.deepEqual(catalog.recentThreadIds.map(String), ["chat"]);
      assert.deepEqual(catalog.pinnedThreadIds, []);
    }),
  );
});
