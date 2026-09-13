import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("118_LearningReviewRecovery", (it) => {
  it.effect("preserves lease guards, data and cascading ownership while adding learning", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 117 });
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json,
      runtime_mode, interaction_mode, created_at, updated_at)
      VALUES ('owner', 'project', 'Owner', '{}', 'full-access', 'default', 'now', 'now')`;
      yield* sql`INSERT INTO thread_activity_leases VALUES ('browser', 'owner', 'browser', 'now')`;
      yield* sql`INSERT INTO learning_jobs (job_id, thread_id, turn_id, provider, model, model_selection_json,
      memory_user_message_count, state, created_at, updated_at)
      VALUES ('historical', 'owner', 'turn', 'codex', 'gpt-5', '{}', 15, 'failed', 'now', 'now')`;
      const artifacts =
        yield* sql`SELECT name, sql FROM sqlite_master WHERE tbl_name = 'thread_activity_leases' AND type IN ('index', 'trigger') ORDER BY name`;
      yield* runMigrations();
      assert.deepEqual(yield* runMigrations(), []);
      assert.deepEqual(
        yield* sql`SELECT name, sql FROM sqlite_master WHERE tbl_name = 'thread_activity_leases' AND type IN ('index', 'trigger') ORDER BY name`,
        artifacts,
      );
      assert.deepEqual(
        yield* sql`SELECT state, attempt_count, next_attempt_at, outcome FROM learning_jobs`,
        [{ state: "failed", attempt_count: 0, next_attempt_at: null, outcome: null }],
      );
      yield* sql`INSERT INTO thread_activity_leases VALUES ('learning', 'owner', 'learning', 'now')`;
      assert.isTrue(
        (yield* Effect.exit(
          sql`INSERT INTO thread_activity_leases VALUES ('bad', 'absent', 'learning', 'now')`,
        ))._tag === "Failure",
      );
      assert.isTrue(
        (yield* Effect.exit(
          sql`INSERT INTO provider_session_runtime (thread_id, provider_name, adapter_key, status, last_seen_at) VALUES ('learning-ephemeral', 'codex', 'codex', 'starting', 'now')`,
        ))._tag === "Failure",
      );
      yield* sql`UPDATE projection_threads SET deleting_at = 'now' WHERE thread_id = 'owner'`;
      assert.isTrue(
        (yield* Effect.exit(
          sql`INSERT INTO thread_activity_leases VALUES ('guarded', 'owner', 'learning', 'now')`,
        ))._tag === "Failure",
      );
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'owner'`;
      assert.deepEqual(yield* sql`SELECT * FROM thread_activity_leases`, []);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
    }),
  );
});
