import { ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionCatalogQuery } from "../Services/ProjectionCatalogQuery.ts";
import { ProjectionCatalogQueryLive } from "./ProjectionCatalogQuery.ts";

const layer = it.layer(
  ProjectionCatalogQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("pending questions in thread catalogs", (it) => {
  it.effect("keeps concurrent questions separate and resolves only the answered thread", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionCatalogQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES
          ('question-a', '__chats__', 'A', 'standard',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           '2026-01-01', '2026-01-01'),
          ('question-b', '__chats__', 'B', 'standard',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           '2026-01-02', '2026-01-02')
      `;
      yield* sql`
        INSERT INTO projection_pending_user_inputs (
          request_id, thread_id, status, questions_json, created_at
        ) VALUES
          ('request-a', 'question-a', 'pending', '[]', '2026-01-01'),
          ('request-b', 'question-b', 'pending', '[]', '2026-01-02')
      `;

      const readFlags = Effect.gen(function* () {
        const catalogs = yield* Effect.all([
          query.getSidebarThreadCatalog(),
          query.getProjectThreadSummaries({
            projectId: ProjectId.makeUnsafe("__chats__"),
            limit: 20,
          }),
        ]);
        return catalogs.map((catalog) =>
          Object.fromEntries(
            catalog.threads.map((thread) => [thread.id, thread.isAwaitingUserInput]),
          ),
        );
      });
      assert.deepEqual(yield* readFlags, [
        { "question-a": true, "question-b": true },
        { "question-a": true, "question-b": true },
      ]);

      yield* sql`
        UPDATE projection_pending_user_inputs
        SET status = 'resolved', resolved_at = '2026-01-03'
        WHERE request_id = 'request-a'
      `;
      assert.deepEqual(yield* readFlags, [
        { "question-a": false, "question-b": true },
        { "question-a": false, "question-b": true },
      ]);
    }),
  );
});
