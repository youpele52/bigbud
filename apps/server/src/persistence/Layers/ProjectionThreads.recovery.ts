import type { ThreadId } from "@bigbud/contracts";
import type { ThreadRecovery } from "@bigbud/contracts/orchestration/orchestration.recovery.ts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";

/**
 * Writes `projection_threads.recovery_json` (migration 138). Only `thread.recovery-updated`
 * changes it, so the general thread upsert leaves the column untouched.
 */
export function makeSetThreadRecovery(sql: SqlClient.SqlClient) {
  return (input: { readonly threadId: ThreadId; readonly recovery: ThreadRecovery | null }) =>
    sql`UPDATE projection_threads
      SET recovery_json = ${input.recovery === null ? null : JSON.stringify(input.recovery)}
      WHERE thread_id = ${input.threadId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.setRecovery:query")),
    );
}
