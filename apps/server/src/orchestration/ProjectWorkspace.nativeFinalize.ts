import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

export interface ProjectWorkspaceFinalizeIdentity {
  readonly operationId: string;
  readonly commandId: string;
  readonly projectId: string;
  readonly requestDigest: string;
  readonly destinationPath: string;
}

const failure = (detail: string) =>
  new OrchestrationCommandInvariantError({
    commandType: "project.reconfigure",
    detail,
  });

/** The engine computes requestDigest from its validated command, never from client options.
 * Authorization alone never releases the fence. Finalization below performs the same check
 * inside the transaction that owns application metadata, receipts and native recovery evidence.
 */
export function assertProjectWorkspaceFinalize(
  sql: SqlClient.SqlClient,
  identity: ProjectWorkspaceFinalizeIdentity,
) {
  return Effect.gen(function* () {
    const rows = yield* sql<{ sourcePath: string; phase: string; operationPhase: string }>`
      SELECT native.source_path AS "sourcePath", native.phase,
        operation.phase AS "operationPhase"
      FROM project_workspace_native_operations native
      JOIN worktree_operations operation USING(operation_id)
      WHERE native.operation_id = ${identity.operationId}
        AND native.command_id = ${identity.commandId} AND native.project_id = ${identity.projectId}
        AND native.destination_path = ${identity.destinationPath}
        AND operation.request_digest = ${identity.requestDigest}
        AND operation.kind = 'access' AND operation.branch = 'workspace-mutation'`;
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      row.phase !== "native-verified" ||
      !["prepared", "dispatched", "moved", "references"].includes(row.operationPhase)
    ) {
      return yield* failure(
        "Workspace finalization is not authorized for this exact verified command. The project remains fenced; inspect its transition recovery status.",
      );
    }
    const project = yield* sql`SELECT 1 FROM projection_projects
      WHERE project_id = ${identity.projectId} AND workspace_root = ${row.sourcePath}
        AND deleted_at IS NULL LIMIT 1`;
    if (project.length !== 1)
      return yield* failure(
        "Workspace finalization source no longer matches the recorded project. Recovery is required; no fence was released.",
      );
    return row;
  });
}

/** Only a verified saga can enter this boundary. Supply the engine's complete SQL commit,
 * including archives/active binding changes, projections, domain events and command receipt.
 * Any failure rolls back BOTH application writes and reservation release. Native mutations
 * cannot run in this callback; they must already have been verified and journaled externally.
 */
export function finalizeProjectWorkspaceTransition<A extends { readonly sequence: number }, E>(
  sql: SqlClient.SqlClient,
  identity: ProjectWorkspaceFinalizeIdentity,
  commitApplication: Effect.Effect<A, E>,
) {
  return sql.withTransaction(
    Effect.gen(function* () {
      yield* assertProjectWorkspaceFinalize(sql, identity);
      // Release SQL admission only inside the still-exclusive application commit transaction.
      yield* sql`UPDATE project_workspace_native_operations SET phase = 'committed', updated_at = ${new Date().toISOString()}
      WHERE operation_id = ${identity.operationId} AND phase = 'native-verified'`;
      yield* sql`UPDATE worktree_operations SET phase = 'completed' WHERE operation_id = ${identity.operationId}`;
      const result = yield* commitApplication;
      yield* sql`UPDATE project_workspace_native_operations SET result_sequence = ${result.sequence}
      WHERE operation_id = ${identity.operationId} AND phase = 'committed'`;
      return result;
    }),
  );
}
