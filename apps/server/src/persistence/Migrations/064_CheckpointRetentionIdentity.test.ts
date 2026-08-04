import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { makeEntityPurgeCheckpointSql } from "../../deletion/Layers/EntityPurge.sql.checkpoints.ts";
import { purgeManifestDigest } from "../PurgeManifest.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("064_CheckpointRetentionIdentity", (it) => {
  it.effect("adds nullable stable identity columns for resumable checkpoint purge", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 63 });
      yield* runMigrations();

      const columns = yield* sql<{ name: string; notNull: number }>`
        SELECT name, "notnull" AS "notNull"
        FROM pragma_table_info('purge_checkpoint_ref_sets')
        WHERE name IN (
          'workspace_canonical_path', 'workspace_device', 'workspace_inode',
          'git_common_dir_canonical_path', 'git_common_dir_device', 'git_common_dir_inode',
          'repository_kind'
        ) ORDER BY name
      `;
      assert.equal(columns.length, 7);
      assert.isTrue(columns.every((column) => column.notNull === 0));
    }),
  );

  it.effect("keeps a captured checkpoint repository binding immutable", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO purge_jobs (
          job_id, entity_kind, entity_id, phase, status, resource_manifest_json, created_at, updated_at
        ) VALUES ('checkpoint-job', 'thread', 'thread-1', 'baseline', 'pending', '[]', 'now', 'now')
      `;
      const queries = makeEntityPurgeCheckpointSql(sql);
      const binding = {
        jobId: "checkpoint-job",
        workspaceCwd: "/workspace",
        repositoryKind: "git" as const,
        workspaceCanonicalPath: "/canonical/workspace",
        workspaceDevice: 1,
        workspaceInode: 2,
        gitCommonDirCanonicalPath: "/canonical/common.git",
        gitCommonDirDevice: 3,
        gitCommonDirInode: 4,
        checkpointRefs: ["refs/bigbud/checkpoints/dGhyZWFkLTE/1"],
      };

      yield* queries.replaceCheckpointRefs(binding);
      yield* queries.replaceCheckpointRefs(binding);
      const rebound = yield* Effect.exit(
        queries.replaceCheckpointRefs({ ...binding, workspaceInode: 99 }),
      );

      assert.equal(rebound._tag, "Failure");
    }),
  );

  it.effect("blocks thread purge completion until checkpoint deletion is verified", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO purge_jobs (
          job_id, entity_kind, entity_id, phase, status, resource_manifest_json,
          resource_manifest_digest, manifest_sealed_at, created_at, updated_at
        ) VALUES ('checkpoint-completion', 'thread', 'thread-2', 'root', 'running', '[]',
          ${purgeManifestDigest([])}, '2026-08-04T00:00:00.000Z', 'now', 'now')
      `;
      const queries = makeEntityPurgeCheckpointSql(sql);
      const withoutSet = yield* Effect.exit(
        sql`UPDATE purge_jobs SET status = 'completed' WHERE job_id = 'checkpoint-completion'`,
      );
      assert.equal(withoutSet._tag, "Failure");

      yield* queries.replaceCheckpointRefs({
        jobId: "checkpoint-completion",
        workspaceCwd: "",
        repositoryKind: null,
        workspaceCanonicalPath: null,
        workspaceDevice: null,
        workspaceInode: null,
        gitCommonDirCanonicalPath: null,
        gitCommonDirDevice: null,
        gitCommonDirInode: null,
        checkpointRefs: [],
      });
      const unverified = yield* Effect.exit(
        sql`UPDATE purge_jobs SET status = 'completed' WHERE job_id = 'checkpoint-completion'`,
      );
      assert.equal(unverified._tag, "Failure");

      yield* queries.markCheckpointRefsVerified("checkpoint-completion");
      yield* sql`UPDATE purge_jobs SET status = 'completed' WHERE job_id = 'checkpoint-completion'`;
    }),
  );
});
