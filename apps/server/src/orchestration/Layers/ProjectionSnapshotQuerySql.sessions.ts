import { Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { ProjectionThreadSessionDbRowSchema } from "./ProjectionSnapshotQuerySql.schemas.ts";

/** Session control authority is hydrated independently of child cards. */
export function makeListProjectionSessionRows(sql: SqlClient.SqlClient) {
  return SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () => sql`
      SELECT
        thread_id AS "threadId", status, provider_name AS "providerName",
        provider_session_id AS "providerSessionId", provider_thread_id AS "providerThreadId",
        runtime_mode AS "runtimeMode", active_turn_id AS "activeTurnId",
        session_epoch AS "sessionEpoch", retained_family AS "retainedFamily",
        reason, last_error AS "lastError", updated_at AS "updatedAt"
      FROM projection_thread_sessions
      ORDER BY thread_id ASC
    `,
  });
}
