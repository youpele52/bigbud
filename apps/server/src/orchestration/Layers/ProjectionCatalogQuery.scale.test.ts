import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { performance } from "node:perf_hooks";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionCatalogQuery } from "../Services/ProjectionCatalogQuery.ts";
import { ProjectionCatalogQueryLive } from "./ProjectionCatalogQuery.ts";

const getHistoryCount = (name: string, defaultValue: number) => {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Number(value);
};

const HISTORY_PROJECT_COUNT = getHistoryCount("BIGBUD_STARTUP_CATALOG_HISTORY_PROJECT_COUNT", 100);
const HISTORY_THREAD_COUNT = getHistoryCount("BIGBUD_STARTUP_CATALOG_HISTORY_THREAD_COUNT", 10_000);
const SELECTED_THREAD_MESSAGE_COUNT = 501;

const layer = it.layer(
  ProjectionCatalogQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionCatalogQuery historical-scale bounds", (it) => {
  it.effect("returns bounded startup summaries and selected detail from historical data", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionCatalogQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        WITH RECURSIVE sequence(value) AS (
          SELECT 0
          UNION ALL
          SELECT value + 1 FROM sequence WHERE value < ${HISTORY_PROJECT_COUNT - 1}
        )
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at,
          last_used_at, deleting_at, deleted_at
        )
        SELECT
          printf('history-project-%03d', value),
          printf('Historical project %d', value),
          printf('/history/%03d', value),
          '[]', '2026-01-01', '2026-01-01',
          printf('2026-01-%02d', 28 - (value % 28)), NULL, NULL
        FROM sequence
      `;
      yield* sql`
        WITH RECURSIVE sequence(value) AS (
          SELECT 0
          UNION ALL
          SELECT value + 1 FROM sequence WHERE value < ${HISTORY_THREAD_COUNT - 1}
        )
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, archived_at, deleted_at
        )
        SELECT
          printf('history-thread-%05d', value),
          printf('history-project-%03d', value % ${HISTORY_PROJECT_COUNT}),
          printf('Historical thread %d', value),
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access',
          'default', '2026-01-01', printf('2026-02-%02d', 28 - (value % 28)), NULL, NULL
        FROM sequence
      `;
      yield* sql`
        WITH RECURSIVE sequence(value) AS (
          SELECT 0
          UNION ALL
          SELECT value + 1 FROM sequence WHERE value < ${SELECTED_THREAD_MESSAGE_COUNT - 1}
        )
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        )
        SELECT
          printf('history-message-%03d', value), 'history-thread-00000', 'user',
          printf('Historical message %d', value), 0,
          printf('2026-03-%02d', 28 - (value % 28)), printf('2026-03-%02d', 28 - (value % 28))
        FROM sequence
      `;

      const catalogStartedAt = performance.now();
      const catalog = yield* query.getStartupProjectCatalog({ scope: "local", limit: 2 });
      const catalogElapsedMs = performance.now() - catalogStartedAt;
      const threadSummariesStartedAt = performance.now();
      const threadPages = yield* Effect.all(
        catalog.projects.map((project) =>
          query.getProjectThreadSummaries({ projectId: project.id }),
        ),
      );
      const threadSummariesElapsedMs = performance.now() - threadSummariesStartedAt;
      const detailStartedAt = performance.now();
      const detail = yield* query.getSelectedThreadDetail({
        threadId: ThreadId.makeUnsafe("history-thread-00000"),
        messageLimit: 999,
      });
      const detailElapsedMs = performance.now() - detailStartedAt;
      const catalogPayloadBytes = Buffer.byteLength(JSON.stringify(catalog));
      const threadPayloadBytes = Buffer.byteLength(JSON.stringify(threadPages));
      const detailPayloadBytes = Buffer.byteLength(JSON.stringify(detail));

      assert.equal(catalog.projects.length, 2);
      assert.isAtMost(threadPages.flatMap((page) => page.threads).length, 10);
      assert.equal(detail.messages.length, 200);
      assert.isTrue(detail.messageWindow.hasOlder);
      assert.isBelow(catalogPayloadBytes, 4 * 1024);
      assert.isBelow(threadPayloadBytes, 16 * 1024);
      assert.isBelow(detailPayloadBytes, 64 * 1024);
      assert.equal(catalog.projects[0]?.id, ProjectId.makeUnsafe("history-project-000"));
      if (process.env.BIGBUD_STARTUP_CATALOG_BENCHMARK === "1") {
        process.stdout.write(
          `${JSON.stringify({
            fixture: "in-memory SQLite; not a production database fixture",
            seededProjects: HISTORY_PROJECT_COUNT,
            seededThreads: HISTORY_THREAD_COUNT,
            catalog: {
              elapsedMs: catalogElapsedMs,
              summaries: catalog.projects.length,
              payloadBytes: catalogPayloadBytes,
            },
            threadSummaries: {
              elapsedMs: threadSummariesElapsedMs,
              summaries: threadPages.flatMap((page) => page.threads).length,
              payloadBytes: threadPayloadBytes,
            },
            selectedDetail: {
              elapsedMs: detailElapsedMs,
              messages: detail.messages.length,
              hasOlderMessages: detail.messageWindow.hasOlder,
              payloadBytes: detailPayloadBytes,
            },
          })}\n`,
        );
      }
    }),
  );
});
