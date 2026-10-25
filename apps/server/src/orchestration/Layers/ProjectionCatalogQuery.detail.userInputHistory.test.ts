import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionCatalogQuery } from "../Services/ProjectionCatalogQuery.ts";
import { ProjectionCatalogQueryLive } from "./ProjectionCatalogQuery.ts";

const layer = it.layer(
  ProjectionCatalogQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const question = {
  id: "mode",
  header: "Mode",
  question: "Which mode?",
  options: [
    { id: "safe", label: "Safe mode", description: "Read only" },
    { id: "write", label: "Write mode", description: "Allow changes" },
  ],
};

layer("selected thread question history", (it) => {
  it.effect(
    "reloads paired historical questions and answers independently of current-turn logs",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const query = yield* ProjectionCatalogQuery;
        yield* sql`INSERT INTO projection_threads (
      thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
      interaction_mode, latest_turn_id, created_at, updated_at
    ) VALUES ('history-thread', 'project', 'History', 'standard',
      '{"provider":"codex","model":"test"}', 'full-access', 'default', 'current-turn',
      '2026-10-24T10:00:00.000Z', '2026-10-24T10:05:00.000Z')`;
        yield* sql`INSERT INTO projection_thread_messages (
      message_id, thread_id, role, text, is_streaming, created_at, updated_at
    ) VALUES
      ('new', 'history-thread', 'user', 'Latest turn', 0, '2026-10-24T10:04:00.000Z', '2026-10-24T10:04:00.000Z'),
      ('old', 'history-thread', 'user', 'Previous turn', 0, '2026-10-24T10:00:00.000Z', '2026-10-24T10:00:00.000Z')`;
        yield* sql`INSERT INTO projection_pending_user_inputs (
      request_id, thread_id, turn_id, status, questions_json, created_at, resolved_at
    ) VALUES ('request-1', 'history-thread', 'old-turn', 'resolved', ${JSON.stringify([question])},
      '2026-10-24T10:01:00.000Z', '2026-10-24T10:02:00.000Z')`;
        yield* sql`INSERT INTO projection_thread_activities (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
    ) VALUES
      ('response', 'history-thread', 'old-turn', 'info', 'user-input.resolved', 'Submitted',
        ${JSON.stringify({ requestId: "request-1", answers: { mode: "safe" } })}, 1, '2026-10-24T10:02:00.000Z'),
      ('tool', 'history-thread', 'current-turn', 'tool', 'tool.completed', 'Done', '{}', 2, '2026-10-24T10:05:00.000Z')`;

        const first = yield* query.getSelectedThreadDetail({
          threadId: ThreadId.makeUnsafe("history-thread"),
          messageLimit: 1,
          activityLimit: 1,
        });
        assert.deepEqual(
          first.activities.map((a) => a.id),
          ["tool"],
        );
        const older = yield* query.getSelectedThreadDetail({
          threadId: ThreadId.makeUnsafe("history-thread"),
          messageLimit: 1,
          activityLimit: 1,
          messageCursor: first.messageWindow.nextCursor!,
        });
        assert.equal(older.activities.length, 3);
        const requested = older.activities.find((a) => a.kind === "user-input.requested");
        assert.deepEqual(requested?.payload, { requestId: "request-1", questions: [question] });
        assert.equal(requested?.createdAt, "2026-10-24T10:01:00.000Z");
        assert.deepEqual(older.activities.find((a) => a.id === "response")?.payload, {
          requestId: "request-1",
          answers: { mode: "safe" },
        });

        const reload = yield* query.getSelectedThreadDetail({
          threadId: ThreadId.makeUnsafe("history-thread"),
          activityLimit: 1,
        });
        assert.equal(reload.activities.length, 3);
        assert.deepEqual(reload.activities, older.activities);

        // A duplicate cancellation/closure must not erase the already delivered answer.
        yield* sql`INSERT INTO projection_thread_activities (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
    ) VALUES ('closed-again', 'history-thread', 'old-turn', 'info', 'user-input.resolved', 'Closed',
      '{"requestId":"request-1","answers":{}}', 3, '2026-10-24T10:03:00.000Z')`;
        const closedAgain = yield* query.getSelectedThreadDetail({
          threadId: ThreadId.makeUnsafe("history-thread"),
          activityLimit: 1,
        });
        assert.equal(
          closedAgain.activities.some((a) => a.id === "response"),
          true,
        );
        yield* sql`INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES ('failed', 'history-thread', 'old-turn', 'error', 'provider.user-input.respond.failed', 'Failed',
          '{"requestId":"request-1"}', 4, '2026-10-24T10:03:00.000Z')`;
        const failed = yield* query.getSelectedThreadDetail({
          threadId: ThreadId.makeUnsafe("history-thread"),
          activityLimit: 1,
        });
        assert.equal(
          failed.activities.some((a) => a.id === "response"),
          false,
        );
        assert.equal(
          failed.activities.some((a) => a.id === "failed"),
          true,
        );
      }),
  );
});
