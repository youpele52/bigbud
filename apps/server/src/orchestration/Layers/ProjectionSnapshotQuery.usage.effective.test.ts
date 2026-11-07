import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { insertProjectionThreadParent } from "../../persistence/Layers/ProjectionThread.test.helpers.ts";
import {
  EFFECTIVE_USAGE_CTE,
  EFFECTIVE_USAGE_DAYS_CTE,
} from "./ProjectionSnapshotQuery.usage.effective.ts";
import { makeGetUsageActiveDays, makeGetUsageEntries } from "./ProjectionSnapshotQuery.usage.ts";

it.layer(SqlitePersistenceMemory)("effective usage query performance regressions", (it) => {
  it.effect(
    "uses turn/message indexes without duplicating pending prompts or counting streaming text",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("indexed-observable");
        const date = "2026-11-06T12:00:00.000Z";
        yield* insertProjectionThreadParent({ sql, threadId });
        for (const id of ["linked", "pending", "other-turn", "bad-estimator"]) {
          yield* sql`INSERT INTO projection_turns
          (thread_id, turn_id, pending_message_id, state, requested_at, started_at,
            checkpoint_files_json, usage_provider, usage_model)
          VALUES (${threadId}, ${id}, ${`prompt-${id}`}, 'completed', ${date}, ${date}, '[]', 'codex', 'model')`;
          const promptTurn = id === "pending" ? null : id === "other-turn" ? "older-turn" : id;
          yield* sql`INSERT INTO projection_thread_messages
          (thread_id, message_id, turn_id, role, text, is_streaming, created_at, updated_at,
            observable_token_count, observable_estimator_version)
          VALUES (${threadId}, ${`prompt-${id}`}, ${promptTurn}, 'user', '', 0, ${date}, ${date}, 3,
            ${id === "bad-estimator" ? "old-estimator" : "observable-text-v1"}),
          (${threadId}, ${`answer-${id}`}, ${id}, 'assistant', '', 0, ${date}, ${date}, 5, 'observable-text-v1'),
          (${threadId}, ${`stream-${id}`}, ${id}, 'assistant', '', 1, ${date}, ${date}, 100, 'observable-text-v1')`;
        }
        const entries = yield* makeGetUsageEntries(sql)(null);
        assert.equal(entries.length, 3);
        for (const entry of entries) {
          assert.equal(entry.inputTokens, 3);
          assert.equal(entry.outputTokens, 5);
          assert.equal(entry.usedTokens, 8);
        }
        const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
        ${sql.literal(EFFECTIVE_USAGE_CTE)} SELECT * FROM effective`;
        assert.ok(
          plan.some(
            ({ detail }) =>
              detail.includes("idx_projection_usage_messages_turn") && detail.includes("turn_id=?"),
          ),
        );
        assert.ok(
          plan.some(({ detail }) => detail.includes("SEARCH m") && detail.includes("message_id=?")),
        );
      }),
  );

  it.effect(
    "streak dates preserve the effective population without evaluating historical attribution",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("streak-without-attribution");
        const date = "2026-10-01T12:00:00.000Z";
        yield* insertProjectionThreadParent({ sql, threadId });
        yield* sql`INSERT INTO projection_turns
        (thread_id, turn_id, pending_message_id, state, requested_at, started_at, checkpoint_files_json)
        VALUES (${threadId}, 'turn', 'prompt', 'completed', ${date}, ${date}, '[]')`;
        yield* sql`INSERT INTO projection_thread_messages
        (thread_id, message_id, turn_id, role, text, is_streaming, created_at, updated_at,
          observable_token_count, observable_estimator_version)
        VALUES (${threadId}, 'prompt', NULL, 'user', '', 0, ${date}, ${date}, 3, 'observable-text-v1')`;
        // A malformed historical request proves date-only queries never decode request payloads.
        yield* sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json)
        VALUES ('malformed-request', 'thread', ${threadId}, 1, 'thread.turn-start-requested',
          ${date}, 'user', '{malformed', '{}')`;
        const days = makeGetUsageActiveDays(sql);
        assert.deepEqual(yield* days("2026-10-02T00:00:00.000Z"), ["2026-10-01"]);
        assert.deepEqual(yield* days("2026-10-01T00:00:00.000Z"), []);
        yield* sql`UPDATE orchestration_events SET payload_json = '{}' WHERE event_id = 'malformed-request'`;
        for (const cte of [EFFECTIVE_USAGE_CTE, EFFECTIVE_USAGE_DAYS_CTE]) {
          const population = yield* sql<{ day: string }>`
          ${sql.literal(cte)} SELECT DISTINCT date(occurred_at) AS day FROM effective
          WHERE used_tokens > 0 AND thread_id = ${threadId}`;
          assert.deepEqual(population, [{ day: "2026-10-01" }]);
        }
      }),
  );
});
