import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("087_ThreadAuxiliaryOwnership", (it) => {
  it.effect("cascades auxiliary thread records", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 86 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES
          ('delete-parent', 'project', 'Delete', '{}', 'full-access', 'default', 'now', 'now'),
          ('keep-parent', 'project', 'Keep', '{}', 'full-access', 'default', 'now', 'now')
      `;
      yield* sql`
        INSERT INTO learning_jobs
          (job_id, thread_id, turn_id, provider, model, model_selection_json, state, created_at, updated_at)
        VALUES
          ('delete-job', 'delete-parent', 'turn', 'provider', 'model', '{}', 'queued', 'now', 'now'),
          ('keep-job', 'keep-parent', 'turn', 'provider', 'model', '{}', 'queued', 'now', 'now')
      `;
      yield* sql`
        INSERT INTO skill_change_proposals
          (proposal_id, thread_id, turn_id, provider, skill_path, original_hash, old_text, new_text, reason, status, created_at)
        VALUES
          ('delete-proposal', 'delete-parent', 'turn', 'provider', 'skill', 'old', 'old', 'new', 'reason', 'pending', 'now'),
           ('keep-proposal', 'keep-parent', 'turn', 'provider', 'skill', 'old', 'old', 'new', 'reason', 'pending', 'now')
      `;
      yield* sql`
        INSERT INTO learning_jobs
          (job_id, thread_id, turn_id, provider, model, model_selection_json, state, created_at, updated_at)
        VALUES ('orphan-job', 'missing-parent', 'turn', 'provider', 'model', '{}', 'queued', 'now', 'now')
      `;
      yield* sql`
        INSERT INTO skill_change_proposals
          (proposal_id, thread_id, turn_id, provider, skill_path, original_hash, old_text, new_text, reason, status, created_at)
        VALUES ('orphan-proposal', 'missing-parent', 'turn', 'provider', 'skill', 'old', 'old', 'new', 'reason', 'pending', 'now')
      `;
      yield* runMigrations();
      assert.deepEqual(yield* runMigrations(), []);
      assert.deepEqual(
        yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'trigger' AND name IN (
            'thread_retention_guard_learning_job_insert',
            'thread_retention_guard_skill_proposal_insert'
          )
          ORDER BY name
        `,
        [
          { name: "thread_retention_guard_learning_job_insert" },
          { name: "thread_retention_guard_skill_proposal_insert" },
        ],
      );
      assert.deepEqual(yield* sql`SELECT thread_id FROM learning_jobs ORDER BY thread_id`, [
        { thread_id: "delete-parent" },
        { thread_id: "keep-parent" },
      ]);
      assert.deepEqual(
        yield* sql`SELECT thread_id FROM skill_change_proposals ORDER BY thread_id`,
        [{ thread_id: "delete-parent" }, { thread_id: "keep-parent" }],
      );
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'delete-parent'`;
      assert.deepEqual(yield* sql`SELECT thread_id FROM learning_jobs`, [
        { thread_id: "keep-parent" },
      ]);
      assert.deepEqual(yield* sql`SELECT thread_id FROM skill_change_proposals`, [
        { thread_id: "keep-parent" },
      ]);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
    }),
  );
});
