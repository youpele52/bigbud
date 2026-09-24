import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { LearningJobRepositoryLive } from "../Layers/LearningJobs.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { LearningJobRepository } from "../Services/LearningJobs.ts";
import repair from "./119_RepairLearningActivityLeases.ts";
import { rebuildTableSql } from "./MigrationTableRebuild.ts";

const layer = LearningJobRepositoryLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));
const owner = ThreadId.makeUnsafe("owner");

const seed = Effect.fn("seedLearningLeaseRepair")(function* (allowed: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 118 });
  // Reproduce installed DDL even though migration 118 is already recorded.
  yield* sql.withTransaction(
    rebuildTableSql(sql, "thread_activity_leases", (ddl) =>
      ddl.replace("'browser', 'computer-use', 'learning'", allowed),
    ),
  );
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json,
    runtime_mode, interaction_mode, created_at, updated_at)
    VALUES (${owner}, 'project', 'Owner', '{}', 'full-access', 'default', 'now', 'now')`;
  yield* sql`INSERT INTO thread_activity_leases VALUES ('existing', ${owner}, 'computer-use', 'now')`;
  yield* sql`INSERT INTO learning_jobs (job_id, thread_id, turn_id, provider, model,
    model_selection_json, state, attempt_count, outcome, created_at, updated_at)
    VALUES ('historical', ${owner}, 'turn', 'codex', 'test', '{}', 'failed', 3, 'failed', 'now', 'now')`;
});

for (const allowed of [
  "'computer-use'",
  "'browser', 'computer-use'",
  "'browser', 'computer-use', 'learning'",
]) {
  it.effect(`repairs ${allowed} without losing leases, guards or job history`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* LearningJobRepository;
      yield* seed(allowed);
      const artifacts = yield* sql`
        SELECT name, sql FROM sqlite_master WHERE type IN ('trigger', 'index') AND sql IS NOT NULL
          AND (tbl_name = 'thread_activity_leases' OR sql LIKE '%thread_activity_leases%')
        ORDER BY name
      `;
      if (!allowed.includes("'learning'")) {
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(repository.acquireLease({ jobId: "review", threadId: owner })),
          ),
        );
      }
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 119 }), [
        [119, "RepairLearningActivityLeases"],
      ]);
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 119 }), []);
      assert.deepEqual(yield* sql`SELECT * FROM thread_activity_leases`, [
        {
          lease_id: "existing",
          thread_id: owner,
          activity_kind: "computer-use",
          acquired_at: "now",
        },
      ]);
      assert.deepEqual(
        yield* sql`
        SELECT name, sql FROM sqlite_master WHERE type IN ('trigger', 'index') AND sql IS NOT NULL
          AND (tbl_name = 'thread_activity_leases' OR sql LIKE '%thread_activity_leases%')
        ORDER BY name
      `,
        artifacts,
      );
      assert.deepEqual(yield* sql`SELECT state, attempt_count, outcome FROM learning_jobs`, [
        { state: "failed", attempt_count: 3, outcome: "failed" },
      ]);
      assert.isTrue(yield* repository.acquireLease({ jobId: "review", threadId: owner }));
      assert.isFalse(yield* repository.acquireLease({ jobId: "overlap", threadId: owner }));
      yield* repository.releaseLease("review");
      yield* sql`INSERT INTO thread_activity_leases VALUES ('browser', ${owner}, 'browser', 'now')`;
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            sql`INSERT INTO thread_activity_leases VALUES ('invalid', ${owner}, 'invalid', 'now')`,
          ),
        ),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            sql`INSERT INTO thread_activity_leases VALUES ('orphan', 'absent', 'learning', 'now')`,
          ),
        ),
      );
      yield* sql`UPDATE projection_threads SET deleting_at = 'now' WHERE thread_id = ${owner}`;
      assert.isFalse(yield* repository.acquireLease({ jobId: "deleted", threadId: owner }));
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            sql`INSERT INTO thread_activity_leases VALUES ('guarded', ${owner}, 'learning', 'now')`,
          ),
        ),
      );
      yield* sql`DELETE FROM projection_threads WHERE thread_id = ${owner}`;
      assert.deepEqual(yield* sql`SELECT * FROM thread_activity_leases`, []);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
    }).pipe(Effect.provide(layer)),
  );
}

it.effect("rolls back an interrupted repair and succeeds on retry", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* LearningJobRepository;
    yield* seed("'computer-use'");
    const before = yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`;
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          sql.withTransaction(
            repair.pipe(Effect.andThen(Effect.fail(new Error("interrupted repair")))),
          ),
        ),
      ),
    );
    assert.deepEqual(yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`, before);
    assert.deepEqual(yield* sql`SELECT lease_id FROM thread_activity_leases`, [
      { lease_id: "existing" },
    ]);
    yield* runMigrations();
    assert.isTrue(yield* repository.acquireLease({ jobId: "retry", threadId: owner }));
    yield* sql.withTransaction(repair);
    assert.deepEqual(yield* sql`SELECT lease_id FROM thread_activity_leases ORDER BY lease_id`, [
      { lease_id: "existing" },
      { lease_id: "learning:retry" },
    ]);
    assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
    assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
  }).pipe(Effect.provide(layer)),
);
