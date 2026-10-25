import { expect, it } from "vitest";
import { it as effectIt, assert } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionBaselineRepositoryLive } from "./ProjectionBaselines.ts";
import { ProjectionBaselineRepository } from "../Services/ProjectionBaselines.ts";
import { insertProjectionThreadParent } from "./ProjectionThread.test.helpers.ts";
import {
  PROJECTION_BASELINE_TABLES,
  PROJECTION_BASELINE_REQUIRED_TABLES,
} from "../ProjectionBaselineSchema.ts";
import { parseBaselinePayload } from "./ProjectionBaselines.payload.ts";

it("accepts old baselines missing only the additive Codex state table", () => {
  const tables = Object.fromEntries(
    PROJECTION_BASELINE_TABLES.filter(
      (name) =>
        name !== "projection_usage_codex_state" && name !== "projection_usage_codex_retired_turns",
    ).map((name) => [name, []]),
  );
  expect(
    parseBaselinePayload(JSON.stringify({ tables })).tables.projection_usage_codex_state,
  ).toEqual([]);
  expect(
    parseBaselinePayload(JSON.stringify({ tables })).tables.projection_usage_codex_retired_turns,
  ).toEqual([]);
  delete tables.projection_usage_contributions;
  expect(() => parseBaselinePayload(JSON.stringify({ tables }))).toThrow(
    "projection_usage_contributions",
  );
});
it("requires but does not capture either operational backfill cursor", () => {
  for (const table of [
    "projection_usage_backfill_state",
    "projection_usage_estimate_backfill_state",
  ]) {
    expect(PROJECTION_BASELINE_REQUIRED_TABLES).toContain(table);
    expect(PROJECTION_BASELINE_TABLES).not.toContain(table);
  }
});

effectIt.layer(ProjectionBaselineRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "usage baseline round trip",
  (it) => {
    it.effect("restores usage and Codex state while resetting both operational cursors", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const baselines = yield* ProjectionBaselineRepository;
        const threadId = ThreadId.makeUnsafe("usage-baseline");
        yield* insertProjectionThreadParent({ sql, threadId });
        const state = JSON.stringify({
          nativeThreadId: "native",
          turnId: "turn",
          fingerprints: ["fingerprint"],
          retired: [],
        });
        yield* sql`INSERT INTO projection_usage_codex_state (thread_id, state_json) VALUES (${threadId}, ${state})`;
        yield* sql`INSERT INTO projection_usage_codex_retired_turns VALUES (${threadId}, 'retired')`;
        yield* sql`INSERT INTO projection_usage_contributions (contribution_id, activity_id, thread_id, provider, model, interaction_mode,
      occurred_at, used_tokens, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, finalized, updated_at)
      VALUES ('baseline-count', 'baseline-activity', ${threadId}, 'codex', 'model', 'default',
        '2026-10-01T00:00:00.000Z', 44, 44, 0, 0, 0, 1, '2026-10-01T00:00:00.000Z')`;
        const payload = yield* baselines.capturePayload();
        yield* sql`UPDATE projection_usage_codex_state SET state_json = '{}' WHERE thread_id = ${threadId}`;
        yield* sql`DELETE FROM projection_usage_codex_retired_turns WHERE thread_id = ${threadId}`;
        yield* sql`UPDATE projection_usage_backfill_state SET last_activity_id = 'done', completed = 1`;
        yield* sql`UPDATE projection_usage_estimate_backfill_state SET last_message_id = 'done', completed = 1`;
        yield* baselines.restorePayload(payload, 0, []);
        const [restored] = yield* sql<{
          state_json: string;
        }>`SELECT state_json FROM projection_usage_codex_state WHERE thread_id = ${threadId}`;
        assert.equal(restored!.state_json, state);
        assert.equal(
          (yield* sql`SELECT 1 FROM projection_usage_codex_retired_turns WHERE thread_id = ${threadId} AND turn_id = 'retired'`)
            .length,
          1,
        );
        const [count] = yield* sql<{
          used_tokens: number;
        }>`SELECT used_tokens FROM projection_usage_contributions WHERE thread_id = ${threadId}`;
        assert.equal(count!.used_tokens, 44);
        const cursors = yield* sql<{
          completed: number;
        }>`SELECT completed FROM projection_usage_backfill_state UNION ALL SELECT completed FROM projection_usage_estimate_backfill_state`;
        assert.deepEqual(
          cursors.map((cursor) => cursor.completed),
          [0, 0],
        );
      }),
    );
  },
);
