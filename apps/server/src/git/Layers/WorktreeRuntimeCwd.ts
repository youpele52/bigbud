import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";

/** Commit operational cwd alongside the canonical metadata event, before recovery can read it. */
export function persistWorktreeRuntimeCwd(sql: SqlClient.SqlClient, event: OrchestrationEvent) {
  if (event.type !== "thread.meta-updated" || event.payload.worktreePath === undefined)
    return Effect.void;
  return sql`UPDATE provider_session_runtime SET runtime_payload_json = json_set(COALESCE(runtime_payload_json,'{}'), '$.cwd',
      COALESCE(${event.payload.worktreePath}, (SELECT p.workspace_root FROM projection_threads t
        JOIN projection_projects p ON p.project_id = t.project_id WHERE t.thread_id = ${event.payload.threadId})))
    WHERE thread_id = ${event.payload.threadId} AND status NOT IN ('starting','running')
      AND resume_cursor_json IS NULL AND provider_name NOT IN ('opencodeV2','opencode')`.pipe(
    Effect.asVoid,
  );
}
