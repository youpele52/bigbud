import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("063_ThreadRetentionFoundation", (it) => {
  it.effect("backfills conservatively and creates retention persistence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, purpose, elevator_summary,
          elevator_summary_message_count, provider_runtime_execution_target_id,
          workspace_execution_target_id, execution_target_id, model_selection_json,
          runtime_mode, interaction_mode, branch, worktree_path, latest_turn_id,
          queued_prompts_json, created_at, updated_at, archived_at, pinned_at, deleting_at, deleted_at
        ) VALUES (
          'thread-backfill', 'project-1', 'Thread', 'standard', 'Thread', 0,
          'local', 'local', 'local', '{"provider":"codex","model":"gpt-5.4"}',
          'full-access', 'default', NULL, NULL, NULL, '[]',
          '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', NULL, NULL, NULL, NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_tasks (task_id, thread_id, task_json, created_at, updated_at)
        VALUES ('task-1', 'thread-backfill', '{"status":"completed"}',
          '2026-01-03T00:00:00.000Z', '2026-01-05T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_pending_user_inputs (
          request_id, thread_id, turn_id, status, questions_json, created_at, resolved_at
        ) VALUES ('input-1', 'thread-backfill', NULL, 'resolved', '[]',
          '2026-01-04T00:00:00.000Z', '2026-01-06T00:00:00.000Z')
      `;

      yield* runMigrations();
      yield* runMigrations();

      const threads = yield* sql<{ lastActivityAt: string }>`
        SELECT last_activity_at AS "lastActivityAt" FROM projection_threads
        WHERE thread_id = 'thread-backfill'
      `;
      assert.deepEqual(threads, [{ lastActivityAt: "2026-01-06T00:00:00.000Z" }]);
      const objects = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE name IN (
          'idx_projection_threads_retention_scan', 'thread_retention_runs',
          'thread_retention_run_items', 'thread_retention_rollout',
          'thread_retention_consent_challenges', 'thread_retention_failures'
        ) ORDER BY name
      `;
      assert.equal(objects.length, 6);
      const rollout = yield* sql<{ hadUserThreads: number }>`
        SELECT had_user_threads AS "hadUserThreads" FROM thread_retention_rollout
      `;
      assert.deepEqual(rollout, [{ hadUserThreads: 1 }]);
    }),
  );
  it.effect("keeps permanent endpoint and runtime guards after projection removal", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-08-04T00:00:00.000Z";
      yield* runMigrations();
      yield* sql`
        INSERT INTO orchestration_deletion_markers (
          entity_kind, entity_id, deletion_sequence, deleted_at
        ) VALUES ('thread', 'permanent-deleted-thread', 9001, ${now})
      `;
      for (const runtimeKind of ["terminal", "shell"] as const) {
        const inserted = yield* Effect.exit(sql`
          INSERT INTO worktree_runtime_leases (
            lease_id, thread_id, runtime_kind, canonical_path, device, inode,
            acquired_at, updated_at
          ) VALUES (${`${runtimeKind}:permanent`}, 'permanent-deleted-thread', ${runtimeKind},
            ${`remote:test:${runtimeKind}`}, -1, 0, ${now}, ${now})
        `);
        assert.equal(inserted._tag, "Failure");
      }
      const activity = yield* Effect.exit(sql`
        INSERT INTO thread_activity_leases (lease_id, thread_id, activity_kind, acquired_at)
        VALUES ('permanent-activity', 'permanent-deleted-thread', 'computer-use', ${now})
      `);
      assert.equal(activity._tag, "Failure");
      const watch = yield* Effect.exit(sql`
        INSERT INTO projection_thread_watches (
          watch_id, watcher_thread_id, watched_thread_id, watched_thread_title,
          source_message_id, status, created_at, triggered_at
        ) VALUES ('permanent-watch', 'permanent-deleted-thread', 'live-thread', 'Live',
          'source-message', 'active', ${now}, NULL)
      `);
      assert.equal(watch._tag, "Failure");
    }),
  );
  it.effect("claims every purge resource kind with exclusive filesystem identities", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-08-04T00:00:00.000Z";
      yield* runMigrations();
      yield* sql`
        INSERT INTO purge_jobs (
          job_id, entity_kind, entity_id, phase, status, resource_manifest_json,
          created_at, updated_at
        ) VALUES ('all-resource-kinds', 'thread', 'claimed-thread', 'baseline', 'running',
          '[]', ${now}, ${now})
      `;
      const resourceKinds = [
        "attachment",
        "managed-worktree",
        "provider-log",
        "terminal-history",
        "project-memory",
        "project-notes",
        "project-kanban",
      ] as const;
      for (const [index, resourceKind] of resourceKinds.entries()) {
        yield* sql`
          INSERT INTO purge_resource_claims (
            job_id, entity_kind, entity_id, resource_kind, relative_path,
            canonical_path, device, inode, resource_type, claimed_at
          ) VALUES ('all-resource-kinds', 'thread', 'claimed-thread', ${resourceKind},
            ${`${resourceKind}-${index}`}, ${`/canonical/${resourceKind}`}, 1, ${index + 1},
            'file', ${now})
        `;
      }
      const kinds = yield* sql<{ resourceKind: string }>`
        SELECT resource_kind AS "resourceKind" FROM purge_resource_claims
        ORDER BY resource_kind
      `;
      assert.deepEqual(
        kinds.map((row) => row.resourceKind),
        [...resourceKinds].toSorted(),
      );
      const duplicateCanonicalPath = yield* Effect.exit(sql`
        INSERT INTO purge_resource_claims (
          job_id, entity_kind, entity_id, resource_kind, relative_path,
          canonical_path, device, inode, resource_type, claimed_at
        ) VALUES ('all-resource-kinds', 'thread', 'claimed-thread', 'provider-log',
          'duplicate-path', '/canonical/attachment', 2, 100, 'file', ${now})
      `);
      assert.equal(duplicateCanonicalPath._tag, "Failure");
      const duplicateIdentity = yield* Effect.exit(sql`
        INSERT INTO purge_resource_claims (
          job_id, entity_kind, entity_id, resource_kind, relative_path,
          canonical_path, device, inode, resource_type, claimed_at
        ) VALUES ('all-resource-kinds', 'thread', 'claimed-thread', 'provider-log',
          'duplicate-identity', '/canonical/other', 1, 1, 'file', ${now})
      `);
      assert.equal(duplicateIdentity._tag, "Failure");
    }),
  );
});
