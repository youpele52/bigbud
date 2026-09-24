import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export interface RetentionResourceSummary {
  readonly removableResourceCount: number;
  readonly completedResourceCount: number;
  readonly retainedResourceCount: number;
  readonly retainedSharedResourceCount: number;
  readonly retainedExternalResourceCount: number;
  readonly unverifiedResourceCount: number;
  readonly pendingResourceCount: number;
  readonly blockedResourceCount: number;
  readonly canonicalPendingCount: number;
}

export function makeRetentionResourceSummary(sql: SqlClient.SqlClient) {
  return (runId: string) =>
    sql<RetentionResourceSummary>`
    WITH plans AS (
      SELECT DISTINCT plan.operation_id, plan.state, proof.canonical_pruned_at
      FROM thread_retention_run_items AS item
      JOIN direct_resource_cleanup_intents AS intent
        ON intent.source_command_id = item.deletion_command_id
      JOIN direct_resource_cleanup_plans AS plan ON plan.intent_id = intent.intent_id
      LEFT JOIN direct_resource_cleanup_proofs AS proof ON proof.operation_id = plan.operation_id
      WHERE item.run_id = ${runId}
    ), resources AS (
      SELECT resource.operation_id, resource.outcome, resource.terminal_at,
        plans.state AS plan_state
      FROM direct_resource_cleanup_resources AS resource
      JOIN plans ON plans.operation_id = resource.operation_id
    ), worktrees AS (
      SELECT worktree.operation_id, worktree.state, plans.state AS plan_state
      FROM direct_resource_cleanup_worktrees AS worktree
      JOIN plans ON plans.operation_id = worktree.operation_id
    )
    SELECT
      ((SELECT COUNT(*) FROM resources WHERE outcome IS NULL OR outcome <> 'retained_shared')
        + (SELECT COUNT(*) FROM worktrees)) AS "removableResourceCount",
      ((SELECT COUNT(*) FROM resources WHERE outcome IN
        ('removed', 'already_absent', 'resumed_and_removed'))
        + (SELECT COUNT(*) FROM worktrees WHERE state = 'completed')) AS "completedResourceCount",
      ((SELECT COUNT(*) FROM resources WHERE outcome = 'retained_shared')
        + (SELECT COUNT(*) FROM direct_resource_cleanup_retained_external
          WHERE operation_id IN (SELECT operation_id FROM plans))
        + (SELECT COUNT(*) FROM direct_resource_cleanup_retained_unverified
          WHERE operation_id IN (SELECT operation_id FROM plans))) AS "retainedResourceCount",
      (SELECT COUNT(*) FROM resources WHERE outcome = 'retained_shared')
        AS "retainedSharedResourceCount",
      (SELECT COUNT(*) FROM direct_resource_cleanup_retained_external
        WHERE operation_id IN (SELECT operation_id FROM plans))
        AS "retainedExternalResourceCount",
      (SELECT COUNT(*) FROM direct_resource_cleanup_retained_unverified
        WHERE operation_id IN (SELECT operation_id FROM plans))
        AS "unverifiedResourceCount",
      ((SELECT COUNT(*) FROM resources
        WHERE terminal_at IS NULL AND plan_state <> 'blocked'
          AND (outcome IS NULL OR outcome <> 'retained_shared'))
        + (SELECT COUNT(*) FROM worktrees
          WHERE state IN ('pending', 'retry') AND plan_state <> 'blocked'))
        AS "pendingResourceCount",
      ((SELECT COUNT(*) FROM resources WHERE outcome IN
        ('identity_mismatch', 'unsupported_entry'))
        + (SELECT COUNT(*) FROM resources WHERE terminal_at IS NULL AND plan_state = 'blocked')
        + (SELECT COUNT(*) FROM worktrees
          WHERE state = 'blocked' OR (state IN ('pending', 'retry') AND plan_state = 'blocked'))
        + (SELECT COUNT(*) FROM plans WHERE state = 'blocked' AND NOT EXISTS (
          SELECT 1 FROM resources AS resource
          WHERE resource.operation_id = plans.operation_id
            AND (resource.outcome IN ('identity_mismatch', 'unsupported_entry')
              OR resource.terminal_at IS NULL)
        ) AND NOT EXISTS (
          SELECT 1 FROM worktrees AS worktree
          WHERE worktree.operation_id = plans.operation_id
            AND (worktree.state = 'blocked' OR worktree.state IN ('pending', 'retry'))
        ))) AS "blockedResourceCount",
      (SELECT COUNT(*) FROM plans WHERE canonical_pruned_at IS NULL) AS "canonicalPendingCount"
  `.pipe(
      Effect.map(
        (rows) =>
          rows[0] ?? {
            removableResourceCount: 0,
            completedResourceCount: 0,
            retainedResourceCount: 0,
            retainedSharedResourceCount: 0,
            retainedExternalResourceCount: 0,
            unverifiedResourceCount: 0,
            pendingResourceCount: 0,
            blockedResourceCount: 0,
            canonicalPendingCount: 0,
          },
      ),
    );
}
