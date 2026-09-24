import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionCatalogQuery } from "../Services/ProjectionCatalogQuery.ts";
import { ProjectionCatalogQueryLive } from "./ProjectionCatalogQuery.ts";

const layer = it.layer(
  ProjectionCatalogQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("saved conversation search", (it) => {
  it.effect("pages real persisted messages and follows updates and deletion", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionCatalogQuery;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('search-project', 'Search Project', '/project', '[]',
          '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES
          ('search-thread', 'search-project', 'Saved thread',
            '{"provider":"codex","model":"test"}', 'full-access', 'default',
            '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
          ('hidden-thread', 'search-project', 'Archived thread',
            '{"provider":"codex","model":"test"}', 'full-access', 'default',
            '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      `;
      yield* sql`UPDATE projection_threads SET archived_at = '2026-01-02T00:00:00Z'
        WHERE thread_id = 'hidden-thread'`;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          ('old', 'search-thread', 'user', 'DeepSeek Harness old', 0,
            '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
          ('new', 'search-thread', 'assistant', 'deepseek harness new', 0,
            '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
          ('hidden', 'hidden-thread', 'user', 'DeepSeek Harness hidden', 0,
            '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z')
      `;
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES ('projection.thread-messages', 0, '2026-01-01T00:00:00Z')
      `;
      const first = yield* query.searchConversationMessages({ query: "seek har", limit: 1 });
      assert.equal(first.status, "ready");
      assert.deepEqual(
        first.hits.map((hit) => hit.messageId),
        ["new"],
      );
      assert.equal(first.hits[0]?.projectName, "Search Project");
      assert.isDefined(first.nextCursor);
      const second = yield* query.searchConversationMessages({
        query: "SEEK HAR",
        limit: 1,
        cursor: first.nextCursor,
      });
      assert.deepEqual(
        second.hits.map((hit) => hit.messageId),
        ["old"],
      );
      assert.isUndefined(second.nextCursor);
      yield* sql`INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES ('punctuation', 'search-thread', 'user', 'C++ primer', 0,
        '2026-01-04T00:00:00Z', '2026-01-04T00:00:00Z')`;
      assert.deepEqual(
        (yield* query.searchConversationMessages({ query: "C++" })).hits.map(
          (hit) => hit.messageId,
        ),
        ["punctuation"],
      );
      yield* sql`INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES ('unicode', 'search-thread', 'user', 'A café discussion', 0,
        '2026-01-05T00:00:00Z', '2026-01-05T00:00:00Z')`;
      const unicode = yield* query.searchConversationMessages({ query: "CAFÉ" });
      assert.deepEqual(
        unicode.hits.map((hit) => hit.messageId),
        ["unicode"],
      );
      assert.include(unicode.hits[0]?.snippet, "café");

      const longQuery = "searchable".repeat(16);
      yield* sql`INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES ('long', 'search-thread', 'user', ${`Before ${longQuery} after`}, 0,
        '2026-01-06T00:00:00Z', '2026-01-06T00:00:00Z')`;
      const longMatch = yield* query.searchConversationMessages({ query: longQuery });
      assert.deepEqual(
        longMatch.hits.map((hit) => hit.messageId),
        ["long"],
      );
      assert.include(longMatch.hits[0]?.snippet, longQuery);
      assert.deepEqual(
        (yield* query.searchConversationMessages({ query: `${longQuery}z` })).hits,
        [],
      );
      yield* sql`INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES ('emoji', 'search-thread', 'user', '😀ab', 0,
        '2026-01-07T00:00:00Z', '2026-01-07T00:00:00Z')`;
      assert.deepEqual((yield* query.searchConversationMessages({ query: "😀a" })).hits, []);
      assert.deepEqual(
        (yield* query.searchConversationMessages({ query: "😀ab" })).hits.map(
          (hit) => hit.messageId,
        ),
        ["emoji"],
      );

      yield* sql`
        INSERT INTO orchestration_event_gaps (sequence, event_id, created_at)
        VALUES (1, 'search-gap', '2026-01-03T00:00:00Z')
      `;
      const catchingUp = yield* query.searchConversationMessages({ query: "seek har" });
      assert.equal(catchingUp.status, "stale");
      assert.lengthOf(catchingUp.hits, 2);

      yield* sql`UPDATE projection_thread_messages SET text = 'changed answer' WHERE message_id = 'new'`;
      assert.deepEqual(
        (yield* query.searchConversationMessages({ query: "seek har" })).hits.map(
          (hit) => hit.messageId,
        ),
        ["old"],
      );
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'search-thread'`;
      assert.deepEqual((yield* query.searchConversationMessages({ query: "seek har" })).hits, []);
    }),
  );

  it.effect("reports unavailable when the index is missing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionCatalogQuery;
      yield* sql`DROP TRIGGER projection_message_search_insert`;
      const result = yield* query.searchConversationMessages({ query: "message" });
      assert.equal(result.status, "unavailable");
      assert.deepEqual(result.hits, []);
    }),
  );
});
