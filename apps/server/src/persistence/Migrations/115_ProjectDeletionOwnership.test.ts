import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { insertProjectionThreadParent } from "../Layers/ProjectionThread.test.helpers.ts";
import Migration0115 from "./115_ProjectDeletionOwnership.ts";

it.layer(NodeSqliteClient.layerMemory())("115_ProjectDeletionOwnership", (it) => {
  it.effect("does not attach operational ownership to replaceable project rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 114 });
      yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('owned', 'Owned', '/tmp/owned', '[]', 'now', 'now')`;
      yield* sql`INSERT INTO projection_notes
      (note_id, project_id, title, content, created_at, updated_at)
      VALUES ('notes/owned/note.md', 'owned', 'Note', 'body', 'now', 'now')`;
      yield* Migration0115;
      yield* sql`DELETE FROM projection_projects WHERE project_id = 'owned'`;
      assert.equal(
        (yield* sql`SELECT 1 FROM projection_notes WHERE project_id = 'owned'`).length,
        1,
      );
      for (const [table, column] of [
        ["orchestration_bootstrap_recipes", "project_id"],
        ["thread_delegations", "target_project_id"],
        ["thread_delegations", "created_project_id"],
      ]) {
        const rows = yield* sql.unsafe<{ detail: string }>(
          `EXPLAIN QUERY PLAN SELECT 1 FROM ${table} WHERE ${column} = ?`,
          ["owned"],
        );
        assert.isTrue(
          rows.some((row) => row.detail.includes("SEARCH") && row.detail.includes("INDEX")),
        );
      }
    }),
  );

  it.effect("detaches retained leased and cross-project children from deleted parents", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 114 });
      for (const [id, project] of [
        ["parent", "gone"],
        ["leased", "gone"],
        ["cross", "live"],
        ["eligible", "gone"],
        ["scheduled", "gone"],
      ]) {
        yield* insertProjectionThreadParent({
          sql,
          threadId: ThreadId.makeUnsafe(id!),
          projectId: project!,
        });
      }
      yield* sql`UPDATE projection_threads SET parent_thread_id = 'parent',
      parent_thread_title = 'Parent', parent_thread_project_id = 'gone'
      WHERE thread_id IN ('leased', 'cross', 'eligible')`;
      yield* sql`INSERT INTO thread_activity_leases (lease_id, thread_id, activity_kind, acquired_at)
      VALUES ('lease', 'leased', 'browser', 'now')`;
      yield* sql`INSERT INTO automation_schedules (
        automation_id, project_id, target_thread_id, title, prompt, cron_expression,
        timezone, created_at, updated_at
      ) VALUES ('shared-schedule', 'live', 'scheduled', 'Shared', 'prompt', '* * * * *',
        'UTC', 'now', 'now')`;
      yield* sql`INSERT INTO orchestration_deletion_markers
      (entity_kind, entity_id, deletion_sequence, deleted_at)
      VALUES ('project', 'gone', 1, 'now')`;
      yield* Migration0115;
      assert.deepEqual(
        yield* sql`SELECT thread_id, parent_thread_id, parent_thread_title, parent_thread_project_id
      FROM projection_threads ORDER BY thread_id`,
        [
          {
            thread_id: "cross",
            parent_thread_id: null,
            parent_thread_title: null,
            parent_thread_project_id: null,
          },
          {
            thread_id: "leased",
            parent_thread_id: null,
            parent_thread_title: null,
            parent_thread_project_id: null,
          },
          {
            thread_id: "scheduled",
            parent_thread_id: null,
            parent_thread_title: null,
            parent_thread_project_id: null,
          },
        ],
      );
      assert.deepEqual(yield* sql`SELECT automation_id FROM automation_schedules`, [
        { automation_id: "shared-schedule" },
      ]);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
    }),
  );

  it.effect("repairs only historical project checkpoints with outstanding evidence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 114 });
      const now = "2026-09-03T00:00:00.000Z";
      const projects = ["active", "recreated"];
      for (const projectId of projects) {
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, scripts_json, created_at, updated_at
          ) VALUES (${projectId}, ${projectId}, '/tmp/project', '[]', ${now}, ${now})
        `;
      }
      for (const [operationId, projectId, eventId] of [
        ["historical-open", "historical-open", "event-open"],
        ["historical-pruned", "historical-pruned", "event-pruned"],
        ["active-proof", "active", "event-active"],
        ["recreated-proof", "recreated", "event-recreated"],
      ]) {
        const payload = JSON.stringify({ projectId, deletedAt: now });
        yield* sql`
          INSERT INTO direct_resource_cleanup_intents (
            intent_id, event_id, source_command_id, source_payload_digest_version,
            source_payload_digest, entity_kind, entity_id, deletion_mode, deletion_requested_at
          ) VALUES (${`intent-${operationId}`}, ${`intent-event-${operationId}`},
            ${`intent-command-${operationId}`}, 'v1', 'digest', 'project', ${projectId}, 'project', ${now})
        `;
        yield* sql`
          INSERT INTO direct_resource_cleanup_plans (
            operation_id, intent_id, finalize_command_id, finalize_payload_json,
            finalize_payload_digest_version, finalize_payload_digest, plan_digest,
            expected_platform, state, created_at, updated_at, completed_at
          ) VALUES (${operationId}, ${`intent-${operationId}`}, ${`finalize-${operationId}`},
            ${JSON.stringify({ projectId, createdAt: now })}, 'v1', 'digest', 'plan',
            'darwin/arm64', 'completed', ${now}, ${now}, ${now})
        `;
        yield* sql`
          INSERT INTO direct_resource_cleanup_proofs (
            operation_id, receipt_status, aggregate_kind, aggregate_id,
            payload_digest_version, payload_digest, event_id, event_sequence,
            event_type, event_payload_json, proof_digest, proven_at, canonical_pruned_at
          ) VALUES (${operationId}, 'accepted', 'project', ${projectId}, 'v1', 'digest', ${eventId},
            1, 'project.deleted', ${payload}, ${"0".repeat(64)}, ${now}, ${now})
        `;
      }
      yield* sql`
        INSERT INTO orchestration_deletion_markers
          (entity_kind, entity_id, deletion_sequence, deleted_at)
        VALUES ('project', 'historical-open', 1, ${now}),
          ('project', 'active', 1, ${now}),
          ('project', 'recreated', 1, ${now})
      `;
      yield* Migration0115;

      assert.deepEqual(
        yield* sql`
          SELECT operation_id, canonical_pruned_at AS "prunedAt"
          FROM direct_resource_cleanup_proofs ORDER BY operation_id
        `,
        [
          { operation_id: "active-proof", prunedAt: now },
          { operation_id: "historical-open", prunedAt: null },
          { operation_id: "historical-pruned", prunedAt: now },
          { operation_id: "recreated-proof", prunedAt: now },
        ],
      );
    }),
  );
});
