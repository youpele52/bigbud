import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { makeRetentionResourceSummary } from "./ThreadRetentionRepository.resourceSummary.ts";

it.layer(SqlitePersistenceMemory)("retention resource outcome accounting", (it) => {
  it.effect("reports shared, external, unverified, pending and blocked separately", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-23T00:00:00.000Z";
      yield* sql`
        INSERT INTO thread_retention_runs
          (run_id, trigger_kind, policy, cutoff_at, status, created_at, updated_at)
        VALUES ('run', 'manual', '7-days', ${now}, 'selecting', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO thread_retention_run_items
          (run_id, thread_id, expected_last_activity_at, deletion_command_id,
            status, created_at, updated_at)
        VALUES ('run', 'thread', ${now}, 'delete-thread', 'deletion_requested', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO direct_resource_cleanup_intents
          (intent_id, event_id, source_command_id, source_payload_digest_version,
            source_payload_digest, entity_kind, entity_id, deletion_mode, deletion_requested_at)
        VALUES ('intent', 'event', 'delete-thread', 'v1', 'digest',
          'thread', 'thread', 'single', ${now})
      `;
      yield* sql`
        INSERT INTO direct_resource_cleanup_plans
          (operation_id, intent_id, finalize_command_id, finalize_payload_json,
            finalize_payload_digest_version, finalize_payload_digest, plan_digest,
            expected_platform, state, created_at, updated_at)
        VALUES ('operation', 'intent', 'finalize', '{}', 'v1', 'digest', 'plan',
          'darwin/arm64', 'blocked', ${now}, ${now})
      `;
      for (const [ordinal, outcome, terminalAt] of [
        [0, "removed", now],
        [1, "retained_shared", now],
        [2, "identity_mismatch", now],
        [3, null, null],
      ] as const) {
        yield* sql`
          INSERT INTO direct_resource_cleanup_resources
            (operation_id, resource_id, original_index, page_ordinal,
              resource_kind, root_kind, relative_path, quarantine_name,
              root_device, root_file_id, parent_device, parent_file_id,
              outcome, terminal_at)
          VALUES ('operation', ${`resource-${ordinal}`}, ${ordinal}, 0,
            'attachment', 'attachment', ${`file-${ordinal}`}, 'quarantine',
            '1', '1', '1', '1', ${outcome}, ${terminalAt})
        `;
      }
      yield* sql`
        INSERT INTO direct_resource_cleanup_retained_external
          (operation_id, resource_id, recorded_path, classified_at)
        VALUES ('operation', 'external', '/outside', ${now})
      `;
      yield* sql`
        INSERT INTO direct_resource_cleanup_retained_unverified
          (operation_id, resource_id, relative_path, reason, classified_at)
        VALUES ('operation', 'unverified', 'unknown.png', 'manifest_missing', ${now})
      `;
      yield* sql`
        INSERT INTO direct_resource_cleanup_worktrees
          (operation_id, resource_id, original_index, resource_json, resource_digest,
            state, created_at, updated_at)
        VALUES ('operation', 'blocked-worktree', 4, '{}',
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'blocked', ${now}, ${now})
      `;
      const summary = yield* makeRetentionResourceSummary(sql)("run");
      assert.deepEqual(summary, {
        removableResourceCount: 4,
        completedResourceCount: 1,
        retainedResourceCount: 3,
        retainedSharedResourceCount: 1,
        retainedExternalResourceCount: 1,
        unverifiedResourceCount: 1,
        pendingResourceCount: 0,
        blockedResourceCount: 3,
        canonicalPendingCount: 1,
      });
      yield* sql`UPDATE direct_resource_cleanup_plans SET state = 'ready'
        WHERE operation_id = 'operation'`;
      const retryable = yield* makeRetentionResourceSummary(sql)("run");
      assert.equal(retryable.pendingResourceCount, 1);
      assert.equal(retryable.blockedResourceCount, 2);
    }),
  );
});
