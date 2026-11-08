import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type {
  ThreadSummary,
  ThreadSummarySortOrder,
} from "@bigbud/contracts/orchestration/orchestration.catalog.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionCatalogQuery } from "../Services/ProjectionCatalogQuery.ts";
import { ProjectionCatalogQueryLive } from "./ProjectionCatalogQuery.ts";

const layer = it.layer(
  ProjectionCatalogQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const projectId = ProjectId.makeUnsafe("sorted-project");
const THREAD_COUNT = 11;

/** The web sidebar's order (`sortThreadsForSidebar`): sort key descending, then id descending. */
function clientOrder(threads: ReadonlyArray<ThreadSummary>, sortOrder: ThreadSummarySortOrder) {
  const key = (thread: ThreadSummary) =>
    sortOrder === "created_at"
      ? thread.createdAt
      : (thread.latestUserMessageAt ?? thread.createdAt);
  return threads
    .toSorted(
      (left, right) => key(right).localeCompare(key(left)) || right.id.localeCompare(left.id),
    )
    .map((thread) => thread.id);
}

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (let index = 0; index < THREAD_COUNT; index += 1) {
    const id = `sorted-${String(index).padStart(2, "0")}`;
    // Creation order differs from activity order, and two threads share a creation time.
    const createdAt = `2026-01-${String(1 + Math.floor(index / 2)).padStart(2, "0")}T00:00:00.000Z`;
    yield* sql`
      INSERT OR IGNORE INTO projection_threads (
        thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at, archived_at, deleted_at
      ) VALUES (
        ${id}, ${projectId}, ${id}, 'standard', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', ${createdAt}, '2026-03-01T00:00:00.000Z', NULL, NULL
      )
    `;
    if (index % 3 !== 0) {
      const messageAt = `2026-02-${String(28 - index).padStart(2, "0")}T00:00:00.000Z`;
      yield* sql`
        INSERT OR IGNORE INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (${`${id}-user`}, ${id}, 'user', 'hi', 0, ${messageAt}, ${messageAt})
      `;
    }
  }
  yield* sql`
    INSERT OR IGNORE INTO projection_threads (
      thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
      interaction_mode, created_at, updated_at, archived_at, deleted_at
    ) VALUES (
      'sorted-archived', ${projectId}, 'Archived', 'standard',
      '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', NULL
    )
  `;
});

layer("ProjectionCatalogQuery display-ordered thread pages", (it) => {
  for (const sortOrder of ["updated_at", "created_at"] as const) {
    it.effect(`pages by ${sortOrder} in the client's display order, 4 at a time`, () =>
      Effect.gen(function* () {
        yield* seed;
        const query = yield* ProjectionCatalogQuery;
        const seen: ThreadSummary[] = [];
        let cursor: ThreadSummary["id"] | undefined;
        let pageCursor = undefined as Parameters<
          typeof query.getProjectThreadSummaries
        >[0]["cursor"];
        let pages = 0;
        do {
          const page = yield* query.getProjectThreadSummaries({
            projectId,
            limit: 4,
            sortOrder,
            ...(pageCursor ? { cursor: pageCursor } : {}),
          });
          assert.isAtMost(page.threads.length, 4);
          seen.push(...page.threads);
          pageCursor = page.nextCursor;
          cursor = page.threads.at(-1)?.id;
          pages += 1;
        } while (pageCursor !== undefined && pages < 10);

        assert.equal(pages, Math.ceil(THREAD_COUNT / 4));
        assert.isDefined(cursor);
        assert.equal(seen.length, THREAD_COUNT);
        assert.deepEqual(
          seen.map((thread) => thread.id),
          clientOrder(seen, sortOrder),
        );
      }),
    );
  }

  it.effect("restarts a cursor from another order and keeps the priority thread", () =>
    Effect.gen(function* () {
      yield* seed;
      const query = yield* ProjectionCatalogQuery;
      const first = yield* query.getProjectThreadSummaries({
        projectId,
        limit: 4,
        sortOrder: "updated_at",
      });
      const restarted = yield* query.getProjectThreadSummaries({
        projectId,
        limit: 4,
        sortOrder: "created_at",
        cursor: first.nextCursor!,
      });
      const fresh = yield* query.getProjectThreadSummaries({
        projectId,
        limit: 4,
        sortOrder: "created_at",
      });
      assert.deepEqual(restarted.threads, fresh.threads);

      const priority = ThreadId.makeUnsafe("sorted-00");
      const withPriority = yield* query.getProjectThreadSummaries({
        projectId,
        limit: 4,
        sortOrder: "updated_at",
        priorityThreadId: priority,
      });
      assert.equal(withPriority.threads[0]?.id, priority);
      assert.equal(withPriority.threads.length, 5);
    }),
  );

  it.effect("keeps latest_user_message_at exact through the migration 154 triggers", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const read = () =>
        sql<{ readonly at: string | null }>`
          SELECT latest_user_message_at AS at FROM projection_threads WHERE thread_id = 'sorted-01'
        `.pipe(Effect.map((rows) => rows[0]?.at ?? null));
      assert.equal(yield* read(), "2026-02-27T00:00:00.000Z");
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES ('sorted-01-later', 'sorted-01', 'user', 'again', 0,
          '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z')
      `;
      assert.equal(yield* read(), "2026-04-01T00:00:00.000Z");
      // Assistant messages never move the sidebar sort key.
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES ('sorted-01-assistant', 'sorted-01', 'assistant', 'reply', 0,
          '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')
      `;
      assert.equal(yield* read(), "2026-04-01T00:00:00.000Z");
      yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'sorted-01-later'`;
      assert.equal(yield* read(), "2026-02-27T00:00:00.000Z");
      // A stale write (e.g. a baseline restore) is corrected to the stored messages.
      yield* sql`
        UPDATE projection_threads SET latest_user_message_at = '2020-01-01T00:00:00.000Z'
        WHERE thread_id = 'sorted-01'
      `;
      assert.equal(yield* read(), "2026-02-27T00:00:00.000Z");
    }),
  );

  it.effect("walks the migration 154 page indexes instead of sorting", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plans = {
        idx_projection_threads_project_activity_page: yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT thread_id FROM projection_threads t
          WHERE t.project_id = ${projectId} AND t.purpose = 'standard'
            AND t.deleted_at IS NULL AND t.archived_at IS NULL AND t.deleting_at IS NULL
          ORDER BY COALESCE(t.latest_user_message_at, t.created_at) DESC, t.thread_id DESC
          LIMIT 5
        `,
        idx_projection_threads_project_created_page: yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT thread_id FROM projection_threads t
          WHERE t.project_id = ${projectId} AND t.purpose = 'standard'
            AND t.deleted_at IS NULL AND t.archived_at IS NULL AND t.deleting_at IS NULL
          ORDER BY t.created_at DESC, t.thread_id DESC
          LIMIT 5
        `,
      };
      for (const [index, plan] of Object.entries(plans)) {
        assert.ok(
          plan.some((row) => row.detail.includes(index)),
          JSON.stringify(plan),
        );
        assert.ok(!plan.some((row) => row.detail.includes("TEMP B-TREE")), JSON.stringify(plan));
      }
    }),
  );
});
