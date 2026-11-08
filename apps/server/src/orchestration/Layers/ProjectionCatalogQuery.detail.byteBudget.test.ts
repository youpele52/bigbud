import { MessageId, ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import {
  THREAD_DETAIL_PAGE_TEXT_BUDGET,
  THREAD_DETAIL_TEXT_PREVIEW_LENGTH,
  THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD,
} from "@bigbud/contracts/orchestration/orchestration.detail.ts";
import {
  MESSAGE_TEXT_CHUNK_MAX_LENGTH,
  type GetMessageTextChunkResult,
} from "@bigbud/contracts/orchestration/orchestration.detail.paging.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionCatalogQuery } from "../Services/ProjectionCatalogQuery.ts";
import { applyMessagePageTextBudget } from "./ProjectionCatalogQuery.boundedText.ts";
import { ProjectionCatalogQueryLive } from "./ProjectionCatalogQuery.ts";

const layer = it.layer(
  ProjectionCatalogQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const threadId = ThreadId.makeUnsafe("budget-thread");
const KB = 1024;

/** Idempotent: the layer (and its in-memory database) is shared by every test below. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT OR IGNORE INTO projection_threads (
      thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
      interaction_mode, latest_turn_id, created_at, updated_at, archived_at, deleted_at
    ) VALUES (
      ${threadId}, 'budget-project', 'Budget', 'standard',
      '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
      'turn-latest', '2026-01-01', '2026-01-09', NULL, NULL
    )
  `;
  // Newest first: a 300 KB message (sent as a 64 KB preview), then 200 KB messages.
  const messages: ReadonlyArray<readonly [string, number, string]> = [
    ["message-1", 300 * KB, "2026-01-08"],
    ["message-2", 200 * KB, "2026-01-07"],
    ["message-3", 200 * KB, "2026-01-06"],
    ["message-4", 200 * KB, "2026-01-05"],
    ["message-5", 10, "2026-01-04"],
  ];
  for (const [id, length, at] of messages) {
    yield* sql`
      INSERT OR IGNORE INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES (${id}, ${threadId}, 'assistant', ${"a".repeat(length)}, 0, ${at}, ${at})
    `;
  }
  yield* sql`
    INSERT OR IGNORE INTO projection_thread_activities (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
    ) VALUES
      ('activity-huge', ${threadId}, 'turn-old', 'tool', 'tool.completed', 'Huge',
        ${JSON.stringify({ output: "o".repeat(300 * KB) })}, 1, '2026-01-05'),
      ('activity-small', ${threadId}, 'turn-old', 'tool', 'tool.completed', 'Small',
        '{"output":"ok"}', 2, '2026-01-05')
  `;
});

layer("ProjectionCatalogQuery size-bounded pages", (it) => {
  it("always keeps at least one message and stops before the budget", () => {
    const rows = [{ text: "x".repeat(900) }, { text: "y".repeat(10) }];
    assert.deepEqual(applyMessagePageTextBudget(rows, 15, 500), {
      rows: [rows[0]!],
      hasOlder: true,
    });
    assert.deepEqual(applyMessagePageTextBudget(rows, 15, 1_000), { rows, hasOlder: false });
    assert.deepEqual(applyMessagePageTextBudget(rows, 1, 1_000), {
      rows: [rows[0]!],
      hasOlder: true,
    });
  });

  it.effect("stops a page at 512 KB of text, truncates huge messages and pages on", () =>
    Effect.gen(function* () {
      yield* seed;
      const query = yield* ProjectionCatalogQuery;

      const first = yield* query.getSelectedThreadDetail({ threadId, messageLimit: 15 });
      const pageText = first.messages.reduce((total, message) => total + message.text.length, 0);
      assert.deepEqual(
        first.messages.map((message) => message.id),
        ["message-1", "message-2", "message-3"],
      );
      assert.isAtMost(pageText, THREAD_DETAIL_PAGE_TEXT_BUDGET);
      assert.isTrue(first.messageWindow.hasOlder);
      assert.equal(first.messageWindow.nextCursor?.messageId, MessageId.makeUnsafe("message-3"));
      const huge = first.messages[0]!;
      assert.equal(huge.text.length, THREAD_DETAIL_TEXT_PREVIEW_LENGTH);
      assert.isTrue(huge.textTruncated);
      assert.equal(huge.textLength, 300 * KB);
      assert.isUndefined(first.messages[1]!.textTruncated);
      assert.isBelow(200 * KB, THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD);

      const second = yield* query.getSelectedThreadDetail({
        threadId,
        messageLimit: 15,
        messageCursor: first.messageWindow.nextCursor!,
      });
      assert.deepEqual(
        second.messages.map((message) => message.id),
        ["message-4", "message-5"],
      );
      assert.isFalse(second.messageWindow.hasOlder);
    }),
  );

  it.effect("returns the rest of a message in bounded chunks", () =>
    Effect.gen(function* () {
      yield* seed;
      const query = yield* ProjectionCatalogQuery;
      const messageId = MessageId.makeUnsafe("message-1");
      let text = "";
      let offset: number | null = 0;
      let calls = 0;
      while (offset !== null) {
        const chunk: Option.Option<GetMessageTextChunkResult> = yield* query.getMessageTextChunk({
          threadId,
          messageId,
          offset,
        });
        assert.isTrue(Option.isSome(chunk));
        const value: GetMessageTextChunkResult = Option.getOrThrow(chunk);
        assert.isAtMost(value.text.length, MESSAGE_TEXT_CHUNK_MAX_LENGTH);
        assert.equal(value.textLength, 300 * KB);
        text += value.text;
        offset = value.nextOffset;
        calls += 1;
      }
      assert.equal(calls, 2);
      assert.equal(text, "a".repeat(300 * KB));

      const clamped = yield* query.getMessageTextChunk({
        threadId,
        messageId,
        offset: 0,
        limit: 10 * MESSAGE_TEXT_CHUNK_MAX_LENGTH,
      });
      assert.equal(Option.getOrThrow(clamped).text.length, MESSAGE_TEXT_CHUNK_MAX_LENGTH);
      const missing = yield* query.getMessageTextChunk({
        threadId,
        messageId: MessageId.makeUnsafe("message-missing"),
        offset: 0,
      });
      assert.isTrue(Option.isNone(missing));
    }),
  );

  it.effect("truncates oversized activity payloads in getTurnActivities", () =>
    Effect.gen(function* () {
      yield* seed;
      const query = yield* ProjectionCatalogQuery;
      const result = yield* query.getTurnActivities({
        threadId,
        turnId: TurnId.makeUnsafe("turn-old"),
        limit: 1,
      });
      // Newest `limit` activities, oldest first.
      assert.deepEqual(
        result.activities.map((activity) => activity.id),
        ["activity-small"],
      );
      assert.isTrue(result.truncated);

      const all = yield* query.getTurnActivities({
        threadId,
        turnId: TurnId.makeUnsafe("turn-old"),
      });
      const huge = all.activities.find((activity) => activity.id === "activity-huge")!;
      assert.deepEqual(huge.payload, {});
      assert.isTrue(huge.payloadTruncated);
      assert.isAbove(huge.payloadLength ?? 0, THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD);
      assert.isUndefined(all.activities.find((a) => a.id === "activity-small")!.payloadTruncated);
    }),
  );
});
