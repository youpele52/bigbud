/**
 * Settles provider runtime rows left `starting`/`running` with no live adapter session.
 *
 * A turn writes `status: "running"` and only a clean `stopAll` or an explicit stop resets it, so
 * a crash or forced exit leaves the row (and its provider lease) claiming work that no process
 * owns. This marks such rows `stopped` exactly as `stopAll` would: the resume cursor is kept, so
 * the session still resumes, and the provider lease is removed because it follows the row.
 *
 * Safety: a row is changed only when it is local, its provider's session listing succeeded and
 * did not include the thread, and it was last written before that listing began. A session
 * started (or a turn begun) after the listing writes a newer `last_seen_at` and is untouched.
 *
 * @module ProviderSessionRuntime.reconcile
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import type {
  ProviderRuntimeReconcileInput,
  ProviderSessionRuntimeRepositoryShape,
} from "../Services/ProviderSessionRuntime.ts";

export const PROVIDER_RUNTIME_RECONCILE_BATCH = 100;
const MAX_BATCHES = 1_000;

export function makeReconcileStaleProviderRuntimes(sql: SqlClient.SqlClient) {
  const batch = (input: ProviderRuntimeReconcileInput, reconciledAt: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly threadId: string }>`
          UPDATE provider_session_runtime SET status = 'stopped', last_seen_at = ${reconciledAt},
            runtime_payload_json = CASE
              WHEN json_valid(runtime_payload_json) AND json_type(runtime_payload_json) = 'object'
              THEN json_set(runtime_payload_json, '$.activeTurnId', json('null'),
                '$.lastRuntimeEvent', 'provider.runtimeReconcile',
                '$.lastRuntimeEventAt', ${reconciledAt})
              ELSE runtime_payload_json END
          WHERE thread_id IN (
            SELECT thread_id FROM provider_session_runtime
            WHERE status IN ('starting', 'running')
              AND provider_runtime_execution_target_id = 'local'
              AND last_seen_at < ${input.observedBefore}
              AND thread_id NOT IN (SELECT value FROM json_each(${JSON.stringify(input.liveThreadIds)}))
              AND provider_name NOT IN (
                SELECT value FROM json_each(${JSON.stringify(input.unavailableProviders)})
              )
              AND (${input.threadIds === undefined ? 1 : 0} = 1 OR thread_id IN (
                SELECT value FROM json_each(${JSON.stringify(input.threadIds ?? [])})
              ))
            ORDER BY last_seen_at ASC, thread_id ASC
            LIMIT ${PROVIDER_RUNTIME_RECONCILE_BATCH}
          )
          RETURNING thread_id AS "threadId"
        `;
        if (rows.length > 0) {
          yield* sql`
            DELETE FROM worktree_runtime_leases
            WHERE runtime_kind = 'provider'
              AND thread_id IN (SELECT value FROM json_each(${JSON.stringify(rows.map((row) => row.threadId))}))
          `;
        }
        return rows.length;
      }),
    );

  const reconcile = Effect.fn("ProviderSessionRuntimeRepository.reconcileStale")(function* (
    input: ProviderRuntimeReconcileInput,
  ) {
    // Rows this pass writes are newer than `observedBefore`, so each batch moves forward.
    const reconciledAt =
      input.reconciledAt > input.observedBefore ? input.reconciledAt : input.observedBefore;
    let stoppedCount = 0;
    for (let index = 0; index < MAX_BATCHES; index += 1) {
      const changed = yield* batch(input, reconciledAt);
      stoppedCount += changed;
      if (changed < PROVIDER_RUNTIME_RECONCILE_BATCH) break;
      yield* Effect.yieldNow;
    }
    return stoppedCount;
  });
  return (input: ProviderRuntimeReconcileInput) =>
    reconcile(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProviderSessionRuntimeRepository.reconcileStale")),
    );
}

/**
 * Provider leases follow their runtime row: one without a `starting`/`running` row has no owner.
 * Runs at repository startup and from the bounded lease sweep, `limit` rows at a time.
 */
export function deleteOrphanProviderLeases(sql: SqlClient.SqlClient, limit?: number) {
  return sql<{ readonly leaseId: string }>`
    DELETE FROM worktree_runtime_leases
    WHERE lease_id IN (
      SELECT lease.lease_id FROM worktree_runtime_leases AS lease
      WHERE lease.runtime_kind = 'provider' AND NOT EXISTS (
        SELECT 1 FROM provider_session_runtime AS runtime
        WHERE runtime.thread_id = lease.thread_id AND runtime.status IN ('starting', 'running')
      )
      ORDER BY lease.lease_id LIMIT ${limit === undefined ? -1 : Math.max(1, Math.floor(limit))}
    )
    RETURNING lease_id AS "leaseId"
  `.pipe(Effect.map((rows) => rows.length));
}

export function reconcileStore(
  sql: SqlClient.SqlClient,
): Pick<ProviderSessionRuntimeRepositoryShape, "reconcileStale"> {
  return { reconcileStale: makeReconcileStaleProviderRuntimes(sql) };
}
