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

const CURRENT_THREAD = ThreadId.makeUnsafe("current-thread");
const CURRENT_PROJECT = ProjectId.makeUnsafe("current-project");

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT OR IGNORE INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at
    ) VALUES
      ('current-project', 'Current', '/current', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
      ('other-project', 'Other', '/other', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
  `;
  yield* sql`
    INSERT OR IGNORE INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, created_at, updated_at
    ) VALUES
      ('current-thread', 'current-project', 'Current thread',
        '{"provider":"codex","model":"test"}', 'full-access', 'default',
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
      ('sibling-thread', 'current-project', 'Sibling thread',
        '{"provider":"codex","model":"test"}', 'full-access', 'default',
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
      ('other-thread', 'other-project', 'Other thread',
        '{"provider":"codex","model":"test"}', 'full-access', 'default',
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
  `;
  // Insert order is rowid order: `other-new` is the newest row overall.
  yield* sql`
    INSERT OR IGNORE INTO projection_thread_messages (
      message_id, thread_id, role, text, is_streaming, created_at, updated_at
    ) VALUES
      ('thread-old', 'current-thread', 'user', 'Needle in a current thread', 0,
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
      ('sibling', 'sibling-thread', 'user', 'needle in a sibling thread', 0,
        '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
      ('other-weak', 'other-thread', 'user', 'a long message that mentions needle once among many other words here', 0,
        '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z'),
      ('other-new', 'other-thread', 'user', 'needle needle', 0,
        '2026-01-04T00:00:00Z', '2026-01-04T00:00:00Z')
  `;
  yield* sql`
    INSERT OR IGNORE INTO projection_state (projector, last_applied_sequence, updated_at)
    VALUES ('projection.thread-messages', 0, '2026-01-01T00:00:00Z')
  `;
});

layer("saved conversation search tiers", (it) => {
  it.effect("orders a page by current thread, current project, relevance, then recency", () =>
    Effect.gen(function* () {
      yield* seed;
      const query = yield* ProjectionCatalogQuery;
      const plain = yield* query.searchConversationMessages({ query: "needle" });
      // Without context: relevance first (the dense short message wins), then recency for ties.
      assert.deepEqual(
        plain.hits.map((hit) => hit.messageId),
        ["other-new", "sibling", "thread-old", "other-weak"],
      );
      const tiered = yield* query.searchConversationMessages({
        query: "needle",
        currentThreadId: CURRENT_THREAD,
        currentProjectId: CURRENT_PROJECT,
      });
      assert.deepEqual(
        tiered.hits.map((hit) => hit.messageId),
        ["thread-old", "sibling", "other-new", "other-weak"],
      );
      assert.deepEqual(
        tiered.currentThreadHits?.map((hit) => hit.messageId),
        ["thread-old"],
      );
      assert.deepEqual(
        tiered.currentProjectHits?.map((hit) => hit.messageId),
        ["sibling", "thread-old"],
      );
    }),
  );

  it.effect("keeps the newest-first rowid cursor while reranking inside each page", () =>
    Effect.gen(function* () {
      yield* seed;
      const query = yield* ProjectionCatalogQuery;
      const context = { currentThreadId: CURRENT_THREAD, currentProjectId: CURRENT_PROJECT };
      const first = yield* query.searchConversationMessages({
        query: "needle",
        limit: 3,
        ...context,
      });
      // Newest three rows by rowid, reranked within the page only: the oldest row of the page
      // (the sibling) moves first, so the cursor must not come from the display order.
      assert.deepEqual(
        first.hits.map((hit) => hit.messageId),
        ["sibling", "other-new", "other-weak"],
      );
      const second = yield* query.searchConversationMessages({
        query: "needle",
        limit: 3,
        ...context,
        ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
      });
      assert.deepEqual(
        second.hits.map((hit) => hit.messageId),
        ["thread-old"],
      );
      assert.isUndefined(second.nextCursor);
      // Scoped tiers are first-page only, so paging never duplicates them.
      assert.isUndefined(second.currentThreadHits);
      assert.isDefined(first.currentThreadHits);
    }),
  );

  it.effect("serves 1–2 character queries from the current thread only", () =>
    Effect.gen(function* () {
      yield* seed;
      const query = yield* ProjectionCatalogQuery;
      const short = yield* query.searchConversationMessages({
        query: "NE",
        currentThreadId: CURRENT_THREAD,
        currentProjectId: CURRENT_PROJECT,
      });
      assert.deepEqual(short.hits, []);
      assert.isUndefined(short.currentProjectHits);
      assert.deepEqual(
        short.currentThreadHits?.map((hit) => hit.messageId),
        ["thread-old"],
      );
      assert.include(short.currentThreadHits?.[0]?.snippet, "Needle");
      const noContext = yield* query.searchConversationMessages({ query: "ne" });
      assert.deepEqual(noContext.hits, []);
      assert.isUndefined(noContext.currentThreadHits);
    }),
  );
});
