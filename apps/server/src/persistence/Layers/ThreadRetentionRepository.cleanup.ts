import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export type RetentionCleanupState = "pending" | "completed" | "blocked" | "aborted";

/** A projection disappearing is not proof that canonical history or files were cleaned. */
export function makeRetentionCleanupReader(sql: SqlClient.SqlClient) {
  return (deletionCommandId: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        intentState: string;
        planState: string | null;
        proofOperationId: string | null;
        canonicalPrunedAt: string | null;
        pendingResources: number;
        blockedResources: number;
        blockedWorktrees: number;
        pendingWorktrees: number;
      }>`
        SELECT intent.state AS "intentState", plan.state AS "planState",
          proof.operation_id AS "proofOperationId",
          proof.canonical_pruned_at AS "canonicalPrunedAt",
          (SELECT COUNT(*) FROM direct_resource_cleanup_resources AS resource
            WHERE resource.operation_id = plan.operation_id AND resource.terminal_at IS NULL)
            AS "pendingResources",
          (SELECT COUNT(*) FROM direct_resource_cleanup_resources AS resource
            WHERE resource.operation_id = plan.operation_id
              AND resource.outcome IN ('identity_mismatch', 'unsupported_entry'))
            AS "blockedResources",
          (SELECT COUNT(*) FROM direct_resource_cleanup_worktrees AS worktree
            WHERE worktree.operation_id = plan.operation_id
              AND worktree.state IN ('pending', 'retry')) AS "pendingWorktrees",
          (SELECT COUNT(*) FROM direct_resource_cleanup_worktrees AS worktree
            WHERE worktree.operation_id = plan.operation_id AND worktree.state = 'blocked')
            AS "blockedWorktrees"
        FROM direct_resource_cleanup_intents AS intent
        LEFT JOIN direct_resource_cleanup_plans AS plan ON plan.intent_id = intent.intent_id
        LEFT JOIN direct_resource_cleanup_proofs AS proof ON proof.operation_id = plan.operation_id
        WHERE intent.source_command_id = ${deletionCommandId}
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return "pending" as RetentionCleanupState;
      if (row.intentState === "cancelled") return "aborted" as RetentionCleanupState;
      if (row.proofOperationId !== null && row.canonicalPrunedAt === null)
        return "pending" as RetentionCleanupState;
      if (row.intentState === "blocked" || row.planState === "blocked")
        return "blocked" as RetentionCleanupState;
      if (
        row.planState !== "completed" ||
        row.canonicalPrunedAt === null ||
        row.pendingResources > 0 ||
        row.pendingWorktrees > 0
      )
        return "pending" as RetentionCleanupState;
      return (
        row.blockedResources > 0 || row.blockedWorktrees > 0 ? "blocked" : "completed"
      ) as RetentionCleanupState;
    });
}
