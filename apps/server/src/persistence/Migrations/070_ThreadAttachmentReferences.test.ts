import { assert, it } from "@effect/vitest";
import { ThreadId } from "@bigbud/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { makeEntityPurgeSql } from "../../deletion/Layers/EntityPurge.sql.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("070_ThreadAttachmentReferences", (it) => {
  it.effect("backfills exact references and marks malformed historical payloads unresolved", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 69 });
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at, attachments_json
        ) VALUES
          ('message-exact', 'thread-a', 'user', '', 0, 'now', 'now',
            '[{"type":"image","id":"attachment-1","name":"a.png","mimeType":"image/png","sizeBytes":1}]'),
          ('message-malformed', 'thread-b', 'user', '', 0, 'now', 'now', '{')
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, tone, kind, summary, payload_json, created_at
        ) VALUES
          ('activity-screenshot', 'thread-c', 'info', 'tool.completed', '',
            '{"title":"computer_use","data":{"result":{"screenshot":{"attachmentId":"screenshot-1","mimeType":"image/png"}}}}', 'now'),
          ('activity-empty-screenshot', 'thread-d', 'info', 'tool.completed', '',
            '{"title":"computer_use","data":{"result":{"screenshot":{"attachmentId":"","mimeType":"image/png"}}}}', 'now'),
          ('activity-whitespace-screenshot', 'thread-e', 'info', 'tool.completed', '',
            '{"title":"computer_use","data":{"result":{"screenshot":{"attachmentId":"  ","mimeType":"image/png"}}}}', 'now')
      `;
      yield* runMigrations();

      const refs = yield* sql<{
        readonly attachmentId: string;
        readonly isUnresolved: number;
        readonly threadId: string;
      }>`SELECT attachment_id AS "attachmentId", is_unresolved AS "isUnresolved", thread_id AS "threadId"
        FROM projection_thread_attachment_refs ORDER BY thread_id`;
      assert.deepEqual(refs, [
        { attachmentId: "attachment-1", isUnresolved: 0, threadId: "thread-a" },
        { attachmentId: "", isUnresolved: 1, threadId: "thread-b" },
        { attachmentId: "screenshot-1", isUnresolved: 0, threadId: "thread-c" },
        { attachmentId: "", isUnresolved: 1, threadId: "thread-d" },
        { attachmentId: "", isUnresolved: 1, threadId: "thread-e" },
      ]);
      const queries = makeEntityPurgeSql(sql);
      const blockedByHistoricalMalformedPayload = yield* queries.attachmentIsShared({
        attachmentId: "not-mentioned",
        threadId: ThreadId.makeUnsafe("thread-a"),
      });
      assert.equal(blockedByHistoricalMalformedPayload.shared, 1);
    }),
  );

  it.effect("maintains exact references through writes and uses the lookup index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`DELETE FROM projection_thread_attachment_refs`;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at, attachments_json
        ) VALUES ('message-wildcard', 'thread-a', 'user', '', 0, 'now', 'now',
          '[{"type":"image","id":"a%_b","name":"a.png","mimeType":"image/png","sizeBytes":1}]')
      `;
      const exact = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_attachment_refs
        WHERE attachment_id = ${"a%_b"} AND thread_id <> 'thread-b'
      `;
      const substring = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_attachment_refs
        WHERE attachment_id = 'a' AND thread_id <> 'thread-b'
      `;
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN SELECT 1 FROM projection_thread_attachment_refs
        WHERE attachment_id IN (${"a%_b"}, '') AND thread_id <> 'thread-b'
      `;
      assert.deepEqual(exact, [{ count: 1 }]);
      assert.deepEqual(substring, [{ count: 0 }]);
      assert.isTrue(
        plan.some((row) => row.detail.includes("idx_projection_thread_attachment_refs_lookup")),
      );
      const queries = makeEntityPurgeSql(sql);
      const shared = yield* queries.attachmentIsShared({
        attachmentId: "a%_b",
        threadId: ThreadId.makeUnsafe("thread-b"),
      });
      const unshared = yield* queries.attachmentIsShared({
        attachmentId: "a%_b",
        threadId: ThreadId.makeUnsafe("thread-a"),
      });
      assert.equal(shared.shared, 1);
      assert.equal(unshared.shared, 0);

      yield* sql`
        UPDATE projection_thread_messages
        SET attachments_json = '[{"type":"image","id":"updated-id","name":"a.png","mimeType":"image/png","sizeBytes":1}]'
        WHERE message_id = 'message-wildcard'
      `;
      const updated = yield* sql<{ readonly attachmentId: string }>`
        SELECT attachment_id AS "attachmentId" FROM projection_thread_attachment_refs
        WHERE source_id = 'message-wildcard'
      `;
      assert.deepEqual(updated, [{ attachmentId: "updated-id" }]);

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, tone, kind, summary, payload_json, created_at
        ) VALUES ('activity-malformed', 'thread-c', 'info', 'test', '', '{', 'now')
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, tone, kind, summary, payload_json, created_at
        ) VALUES
          ('activity-empty', 'thread-d', 'info', 'tool.completed', '',
            '{"title":"computer_use","data":{"result":{"screenshot":{"attachmentId":"","mimeType":"image/png"}}}}', 'now'),
          ('activity-whitespace', 'thread-e', 'info', 'tool.completed', '',
            '{"title":"computer_use","data":{"result":{"screenshot":{"attachmentId":" ","mimeType":"image/png"}}}}', 'now')
      `;
      const unresolvedScreenshots = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_attachment_refs
        WHERE source_kind = 'activity' AND source_id IN ('activity-empty', 'activity-whitespace')
          AND attachment_id = '' AND is_unresolved = 1
      `;
      assert.deepEqual(unresolvedScreenshots, [{ count: 2 }]);
      const blockedByUnresolved = yield* queries.attachmentIsShared({
        attachmentId: "not-mentioned",
        threadId: ThreadId.makeUnsafe("thread-a"),
      });
      assert.equal(blockedByUnresolved.shared, 1);

      yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'message-wildcard'`;
      const deleted = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_attachment_refs WHERE source_id = 'message-wildcard'
      `;
      assert.deepEqual(deleted, [{ count: 0 }]);
    }),
  );
});
