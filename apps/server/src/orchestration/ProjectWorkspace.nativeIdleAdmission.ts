import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

/** Positively observed app-owned idle handles may close AFTER admission is fenced, never before.
 * A racing canonical start/turn/activity still refuses acquisition atomically.
 */
export function assertIdleWorkspaceOwner(
  sql: SqlClient.SqlClient,
  threadId: string,
  providers: readonly string[],
) {
  return Effect.gen(function* () {
    const allowed = JSON.stringify(providers);
    const active =
      yield* sql`SELECT 1 FROM projection_thread_sessions WHERE thread_id = ${threadId} AND
      (active_turn_id IS NOT NULL OR status NOT IN ('ready','stopped','error') OR
        (status = 'ready' AND provider_name NOT IN (SELECT value FROM json_each(${allowed}))))
      UNION ALL SELECT 1 FROM provider_session_runtime WHERE thread_id = ${threadId} AND
        (status = 'starting' OR (status = 'running' AND provider_name NOT IN (SELECT value FROM json_each(${allowed}))))
      UNION ALL SELECT 1 FROM worktree_runtime_leases WHERE thread_id = ${threadId}
      UNION ALL SELECT 1 FROM thread_activity_leases WHERE thread_id = ${threadId}
      UNION ALL SELECT 1 FROM provider_turn_admissions WHERE owner_thread_id = ${threadId} AND state <> 'terminal'
      UNION ALL SELECT 1 FROM projection_turns WHERE thread_id = ${threadId} AND state IN ('pending','running')
      UNION ALL SELECT 1 FROM projection_threads WHERE thread_id = ${threadId} AND
        (deleting_at IS NOT NULL OR json_array_length(queued_prompts_json) > 0 OR pending_turn_control_operation_json IS NOT NULL)
      LIMIT 1`;
    if (active.length)
      return yield* new OrchestrationCommandInvariantError({
        commandType: "project.reconfigure",
        detail: `Thread '${threadId}' started work or has an unconfirmed owner. No idle session was stopped and no files were transferred.`,
      });
  });
}
