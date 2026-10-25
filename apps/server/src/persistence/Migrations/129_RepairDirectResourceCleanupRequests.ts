import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(direct_resource_cleanup_attempts)
  `;

  // Installed migration 108 predates persisted requests. NULL means unavailable history,
  // never a fabricated request that might replay destructive filesystem operations.
  if (!columns.some((column) => column.name === "request_json")) {
    yield* sql`ALTER TABLE direct_resource_cleanup_attempts
      ADD COLUMN request_json TEXT CHECK (json_valid(request_json))`;
  }
  if (!columns.some((column) => column.name === "request_frame_hex")) {
    yield* sql`ALTER TABLE direct_resource_cleanup_attempts
      ADD COLUMN request_frame_hex TEXT CHECK (
        length(request_frame_hex) BETWEEN 10 AND 2097160
        AND request_frame_hex NOT GLOB '*[^0-9a-f]*'
      )`;
  }
  if (!columns.some((column) => column.name === "deadline_unix_ms")) {
    yield* sql`ALTER TABLE direct_resource_cleanup_attempts
      ADD COLUMN deadline_unix_ms INTEGER CHECK (deadline_unix_ms > 0)`;
  }

  // Nullable historical columns must not weaken the contract for new attempts.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS direct_resource_cleanup_attempt_request_required
    BEFORE INSERT ON direct_resource_cleanup_attempts WHEN
      NEW.request_json IS NULL OR NOT json_valid(NEW.request_json) OR
      NEW.request_frame_hex IS NULL OR
      length(NEW.request_frame_hex) NOT BETWEEN 10 AND 2097160 OR
      NEW.request_frame_hex GLOB '*[^0-9a-f]*' OR
      NEW.deadline_unix_ms IS NULL OR NEW.deadline_unix_ms <= 0
    BEGIN SELECT RAISE(ABORT, 'direct cleanup attempt request is required'); END
  `;
  yield* sql`DROP TRIGGER IF EXISTS direct_resource_cleanup_attempt_identity_immutable`;
  yield* sql`
    CREATE TRIGGER direct_resource_cleanup_attempt_identity_immutable
    BEFORE UPDATE ON direct_resource_cleanup_attempts WHEN
      OLD.operation_id IS NOT NEW.operation_id OR OLD.page_ordinal IS NOT NEW.page_ordinal OR
      OLD.page_digest IS NOT NEW.page_digest OR OLD.resource_ids_json IS NOT NEW.resource_ids_json OR
      OLD.request_json IS NOT NEW.request_json OR OLD.request_frame_hex IS NOT NEW.request_frame_hex OR
      OLD.deadline_unix_ms IS NOT NEW.deadline_unix_ms OR OLD.created_at IS NOT NEW.created_at
    BEGIN SELECT RAISE(ABORT, 'direct cleanup attempt identity is immutable'); END
  `;

  // Preserve attempts, resources and proofs, but require manual recovery when the original
  // request cannot be replayed faithfully. Terminal plans and existing blocked reasons stay intact.
  yield* sql`
    UPDATE direct_resource_cleanup_plans SET state = 'blocked',
      last_error_code = 'legacy_attempt_request_unavailable', lease_id = NULL,
      lease_expires_at = NULL, next_attempt_at = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE state NOT IN ('completed', 'cancelled', 'blocked') AND EXISTS (
      SELECT 1 FROM direct_resource_cleanup_attempts AS attempt
      WHERE attempt.operation_id = direct_resource_cleanup_plans.operation_id
        AND (attempt.request_json IS NULL OR attempt.request_frame_hex IS NULL
          OR attempt.deadline_unix_ms IS NULL)
    )
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS direct_resource_cleanup_plan_request_guard
    BEFORE UPDATE OF state ON direct_resource_cleanup_plans
    WHEN NEW.state IN ('prepared', 'ready', 'running', 'retry') AND EXISTS (
      SELECT 1 FROM direct_resource_cleanup_attempts AS attempt
      WHERE attempt.operation_id = NEW.operation_id
        AND (attempt.request_json IS NULL OR attempt.request_frame_hex IS NULL
          OR attempt.deadline_unix_ms IS NULL)
    )
    BEGIN SELECT RAISE(ABORT, 'legacy cleanup attempt request is unavailable'); END
  `;
});
