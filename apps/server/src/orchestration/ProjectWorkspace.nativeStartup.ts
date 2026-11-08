import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { reconcileProjectWorkspaceTransition } from "./ProjectWorkspace.nativeRecovery.ts";
import type { QualifiedWorkspaceNativeAccess } from "./ProjectWorkspace.nativeCoordinator.ts";

/** Restart inspection never copies, moves, starts, prompts, replays, or releases a reservation.
 * Muse-only staged resets may become ready; canonical commit still requires exact retained command.
 */
export function reconcileProjectWorkspaceStartup(
  sql: SqlClient.SqlClient,
  inspect?: QualifiedWorkspaceNativeAccess["inspect"],
) {
  return Effect.gen(function* () {
    const installed =
      yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_workspace_native_operations'`;
    if (!installed.length) return [];
    const rows = yield* sql<{
      operationId: string;
      requestDigest: string;
    }>`SELECT native.operation_id AS "operationId",
      operation.request_digest AS "requestDigest" FROM project_workspace_native_operations native
      JOIN worktree_operations operation USING(operation_id) WHERE native.phase NOT IN ('committed','rejected')`;
    const results = [];
    for (const row of rows) {
      const result = yield* reconcileProjectWorkspaceTransition(
        sql,
        row,
        inspect ??
          (() =>
            Effect.fail(
              new Error("Qualified native inspection is unavailable; recovery remains fenced."),
            )),
      ).pipe(Effect.result);
      if (result._tag === "Failure")
        yield* Effect.logWarning("Project workspace recovery remains fenced", {
          operationId: row.operationId,
          error: String(result.failure),
        });
      results.push({ operationId: row.operationId, result });
    }
    return results;
  });
}
