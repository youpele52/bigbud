import { ThreadId } from "@bigbud/contracts";
import { Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { unresolvedAdmissionSql } from "../../persistence/Layers/ProviderTurnAdmissions.activity.ts";

/** Used inside the resource-claim transaction and again immediately before destructive operations. */
export function makeCountThreadRuntimes(sql: SqlClient.SqlClient) {
  return SqlSchema.findOne({
    Request: Schema.Struct({ threadId: ThreadId }),
    Result: Schema.Struct({ count: Schema.Number }),
    execute: ({ threadId }) => sql`
      SELECT (
        (SELECT COUNT(*) FROM thread_activity_leases WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM worktree_runtime_leases WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM provider_session_runtime WHERE thread_id = ${threadId} AND status IN ('starting', 'running')) +
        (SELECT COUNT(*) FROM (${sql.unsafe(unresolvedAdmissionSql("?"), [threadId, threadId])}))
      ) AS count
    `,
  });
}
