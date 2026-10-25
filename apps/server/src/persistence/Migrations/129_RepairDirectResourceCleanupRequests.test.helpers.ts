import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

export const requestColumns = ["request_json", "request_frame_hex", "deadline_unix_ms"] as const;
export const at = "2026-10-16T00:00:00.000Z";

/** Reproduces an installed migration 108 without its later request-persistence columns. */
export const makeLegacySchema = Effect.fn("makeLegacyCleanupRequestSchema")(function* (
  sql: SqlClient.SqlClient,
  missing: ReadonlyArray<(typeof requestColumns)[number]> = requestColumns,
) {
  yield* sql`DROP TRIGGER direct_resource_cleanup_attempt_identity_immutable`;
  for (const column of missing) {
    yield* sql.unsafe(`ALTER TABLE direct_resource_cleanup_attempts DROP COLUMN ${column}`);
  }
  yield* sql`
    CREATE TRIGGER direct_resource_cleanup_attempt_identity_immutable
    BEFORE UPDATE ON direct_resource_cleanup_attempts WHEN
      OLD.operation_id IS NOT NEW.operation_id OR OLD.page_ordinal IS NOT NEW.page_ordinal OR
      OLD.page_digest IS NOT NEW.page_digest OR OLD.resource_ids_json IS NOT NEW.resource_ids_json OR
      OLD.created_at IS NOT NEW.created_at
    BEGIN SELECT RAISE(ABORT, 'direct cleanup attempt identity is immutable'); END
  `;
});

export const initialize = runMigrations({ toMigrationInclusive: 128 });

/** Seeds immutable cleanup history independently of orchestration/projection fixtures. */
export const seedPlan = Effect.fn("seedCleanupRequestRepairPlan")(function* (
  sql: SqlClient.SqlClient,
  id: string,
  state: "ready" | "running" | "retry" | "blocked" | "completed" | "cancelled" = "ready",
) {
  yield* sql`
    INSERT INTO direct_resource_cleanup_intents (
      intent_id, event_id, source_command_id, source_payload_digest_version, source_payload_digest,
      entity_kind, entity_id, deletion_mode, deletion_requested_at
    ) VALUES (${id}, ${id}, ${id}, 'v1', 'digest', 'thread', ${id}, 'subtree', ${at})
  `;
  yield* sql`
    INSERT INTO direct_resource_cleanup_plans (
      operation_id, intent_id, finalize_command_id, finalize_payload_json,
      finalize_payload_digest_version, finalize_payload_digest, plan_digest, expected_platform,
      state, lease_id, lease_expires_at, created_at, updated_at, completed_at
    ) VALUES (
      ${id}, ${id}, ${id}, '{}', 'v1', 'digest', 'plan', 'darwin/arm64', ${state},
      ${state === "running" ? "old-lease" : null}, ${state === "running" ? "2999-01-01" : null},
      ${at}, ${at}, ${state === "completed" || state === "cancelled" ? at : null}
    )
  `;
  yield* sql`
    INSERT INTO direct_resource_cleanup_resources (
      operation_id, resource_id, original_index, page_ordinal, resource_kind, root_kind,
      relative_path, quarantine_name, root_device, root_file_id, parent_device, parent_file_id
    ) VALUES (${id}, 'resource', 0, 0, 'attachment', 'attachment', 'resource', '.cleanup', '1', '2', '1', '2')
  `;
  yield* sql`
    INSERT INTO direct_resource_cleanup_proofs (
      operation_id, receipt_status, aggregate_kind, aggregate_id, payload_digest_version,
      payload_digest, event_id, event_sequence, event_type, event_payload_json,
      proof_digest, proven_at, canonical_pruned_at
    ) VALUES (${id}, 'accepted', 'thread', ${id}, 'v1', 'digest', ${id}, 1, 'thread.deleted',
      '{}', ${"a".repeat(64)}, ${at}, ${at})
  `;
});

export const seedAttempt = Effect.fn("seedCleanupRequestRepairAttempt")(function* (
  sql: SqlClient.SqlClient,
  id: string,
  state: "prepared" | "sent" | "ambiguous" | "recorded" = "ambiguous",
) {
  yield* sql`
    INSERT INTO direct_resource_cleanup_attempts (
      attempt_id, operation_id, page_ordinal, page_digest, resource_ids_json,
      request_json, request_frame_hex, deadline_unix_ms, state, created_at, updated_at
    ) VALUES (${id}, ${id}, 0, 'page', '["resource"]', '{"original":true}', '0000000000',
      1800000000000, ${state}, ${at}, ${at})
  `;
});
