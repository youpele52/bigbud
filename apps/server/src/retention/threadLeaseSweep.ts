import { retainedDirectOwnerKey } from "./directShellLease";
/**
 * Bounded sweep of leases that no longer stand for real work, so retention stops skipping
 * threads for them. One tick deletes at most `limit` rows across every category:
 *
 * - provider leases whose runtime row is not `starting`/`running` (a NULL PID with no live
 *   runtime; provider leases follow their runtime row);
 * - terminal and shell leases this process does not hold that have expired, have no expiry
 *   (written before expiries existed), or whose process is definitely gone;
 * - browser and computer-use leases this process does not hold that have expired or have no
 *   expiry;
 * - learning cleanup fences whose job is gone, or is not running and untouched for 7 days.
 *
 * A held lease is renewed by the heartbeat, so "not held and expired" only matches a lease
 * whose holder is gone. A crash mid-sweep leaves the remaining rows for the next tick.
 *
 * @module threadLeaseSweep
 */
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { deleteOrphanProviderLeases } from "../persistence/Layers/ProviderSessionRuntime.reconcile.ts";
import { heldThreadLeaseIds } from "./threadLeaseHeartbeat.ts";
import { isDefinitelyTerminated } from "./worktreeRuntimeLease.ts";

export const THREAD_LEASE_SWEEP_LIMIT = 100;
export const THREAD_LEASE_SWEEP_INTERVAL = "5 minutes";
export const LEARNING_LEASE_STALE_MS = 7 * 24 * 60 * 60_000;

export interface ThreadLeaseSweepResult {
  readonly provider: number;
  readonly runtime: number;
  readonly activity: number;
  readonly learning: number;
}

export const sweepThreadLeases = Effect.fn("sweepThreadLeases")(function* (
  sql: SqlClient.SqlClient,
  options: { readonly nowMs?: number; readonly limit?: number } = {},
) {
  const nowMs = options.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const held = JSON.stringify(heldThreadLeaseIds());
  let budget = Math.max(1, Math.floor(options.limit ?? THREAD_LEASE_SWEEP_LIMIT));

  const provider = yield* deleteOrphanProviderLeases(sql, budget);
  budget -= provider;

  let runtime = 0;
  if (budget > 0) {
    const candidates = yield* sql<{
      readonly leaseId: string;
      readonly threadId: string;
      readonly runtimeKind: string;
      readonly processId: number | null;
      readonly expired: number;
    }>`
      SELECT lease_id AS "leaseId", process_id AS "processId", thread_id AS "threadId", runtime_kind AS "runtimeKind",
        CASE WHEN expires_at IS NULL OR expires_at <= ${now} THEN 1 ELSE 0 END AS expired
      FROM worktree_runtime_leases
      WHERE runtime_kind IN ('terminal', 'shell')
        AND lease_id NOT IN (SELECT value FROM json_each(${held}))
      ORDER BY expired DESC, lease_id ASC
      LIMIT ${budget}
    `;
    const stale = candidates.filter(
      (row) =>
        row.expired === 1 || (row.processId !== null && isDefinitelyTerminated(row.processId)),
    );
    if (stale.length > 0) {
      const candidates = JSON.stringify(
        stale.map((row) => ({ leaseId: row.leaseId, ownerKey: retainedDirectOwnerKey(row) })),
      );
      runtime = (yield* sql`
        DELETE FROM worktree_runtime_leases
        WHERE lease_id IN (
          SELECT json_extract(value, '$.leaseId') FROM json_each(${candidates})
          WHERE NOT EXISTS (SELECT 1 FROM direct_shell_launch_owners
            WHERE owner_key = json_extract(value, '$.ownerKey'))
        )
          AND lease_id NOT IN (SELECT value FROM json_each(${held}))
        RETURNING lease_id
      `).length;
    }
    budget -= runtime;
  }

  let activity = 0;
  if (budget > 0) {
    activity = (yield* sql`
      DELETE FROM thread_activity_leases WHERE lease_id IN (
        SELECT lease_id FROM thread_activity_leases
        WHERE activity_kind <> 'learning'
          AND (expires_at IS NULL OR expires_at <= ${now})
          AND lease_id NOT IN (SELECT value FROM json_each(${held}))
        ORDER BY lease_id LIMIT ${budget}
      )
      RETURNING lease_id
    `).length;
    budget -= activity;
  }

  let learning = 0;
  if (budget > 0) {
    const staleBefore = new Date(nowMs - LEARNING_LEASE_STALE_MS).toISOString();
    learning = (yield* sql`
      DELETE FROM thread_activity_leases WHERE lease_id IN (
        SELECT lease.lease_id FROM thread_activity_leases AS lease
        LEFT JOIN learning_jobs AS job ON lease.lease_id = 'learning:' || job.job_id
        WHERE lease.activity_kind = 'learning'
          AND (
            (job.job_id IS NULL AND lease.acquired_at <= ${staleBefore})
            OR (job.state <> 'reviewing' AND job.updated_at <= ${staleBefore})
          )
        ORDER BY lease.lease_id LIMIT ${budget}
      )
      RETURNING lease_id
    `).length;
  }

  return { provider, runtime, activity, learning } satisfies ThreadLeaseSweepResult;
});
