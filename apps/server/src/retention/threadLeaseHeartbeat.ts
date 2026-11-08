/**
 * Expiry and heartbeat for the leases that make thread retention skip a thread.
 *
 * Terminal, shell, browser and computer-use leases are written with an `expires_at` and
 * registered here by their holder. While this process holds a lease, the retention maintenance
 * loop renews its expiry every minute; a holder that releases it unregisters it. A lease left
 * behind by a crash or forced exit is no longer renewed, so it expires within the TTL and the
 * bounded lease sweep removes it. There is one backend per state directory, so leases this
 * process does not hold belong to no one.
 *
 * Provider leases follow their runtime row and learning leases are cleanup fences swept by job
 * age, so neither is registered here.
 *
 * @module threadLeaseHeartbeat
 */
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** A held lease is renewed every minute, so it expires only after five missed heartbeats. */
export const THREAD_LEASE_TTL_MS = 5 * 60_000;
export const THREAD_LEASE_HEARTBEAT_INTERVAL = "1 minute";
const RENEW_CHUNK = 100;

const heldLeaseIds = new Set<string>();

export function threadLeaseExpiresAt(nowMs = Date.now()): string {
  return new Date(nowMs + THREAD_LEASE_TTL_MS).toISOString();
}

/** Call after the lease row was written; the heartbeat renews it until it is released. */
export function holdThreadLease(leaseId: string): void {
  heldLeaseIds.add(leaseId);
}

/** Call when the holder deletes its lease row (or gives up writing it). */
export function releaseThreadLease(leaseId: string): void {
  heldLeaseIds.delete(leaseId);
}

export function heldThreadLeaseIds(): ReadonlyArray<string> {
  return [...heldLeaseIds];
}

/**
 * Pushes every held lease's expiry forward. Lease IDs are unique across both tables, so one
 * list is applied to each, `RENEW_CHUNK` at a time.
 */
export const renewHeldThreadLeases = Effect.fn("renewHeldThreadLeases")(function* (
  sql: SqlClient.SqlClient,
  nowMs = Date.now(),
) {
  const leaseIds = heldThreadLeaseIds();
  const expiresAt = threadLeaseExpiresAt(nowMs);
  for (let start = 0; start < leaseIds.length; start += RENEW_CHUNK) {
    const chunk = JSON.stringify(leaseIds.slice(start, start + RENEW_CHUNK));
    yield* sql`UPDATE worktree_runtime_leases SET expires_at = ${expiresAt}
      WHERE lease_id IN (SELECT value FROM json_each(${chunk}))`;
    yield* sql`UPDATE thread_activity_leases SET expires_at = ${expiresAt}
      WHERE lease_id IN (SELECT value FROM json_each(${chunk}))`;
  }
  return leaseIds.length;
});
