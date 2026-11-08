import type * as SqlClient from "effect/unstable/sql/SqlClient";

type Lease = { until: number; refreshedAt: number };
const registries = new WeakMap<SqlClient.SqlClient, Map<string, Map<string, Lease>>>();
// Disconnect cleanup addresses caller identity across SQL clients without retaining clients.
const callers = new Map<string, Map<string, Lease>>();
export function updateOrganizationEngagement(
  sql: SqlClient.SqlClient,
  caller: string,
  thread: string,
  engaged: boolean,
  now = Date.now(),
): boolean {
  let registry = registries.get(sql);
  if (!registry) {
    registry = new Map();
    registries.set(sql, registry);
  }
  for (const [id, leases] of registry) {
    for (const [threadId, lease] of leases)
      if (lease.until <= now || lease.refreshedAt > now) leases.delete(threadId);
    if (leases.size === 0) {
      registry.delete(id);
      callers.delete(id);
    }
  }
  let leases = registry.get(caller);
  if (!engaged) {
    leases?.delete(thread);
    return true;
  }
  if (!leases) {
    if (callers.size >= 10000) return false;
    leases = new Map();
    registry.set(caller, leases);
    callers.set(caller, leases);
  }
  const old = leases.get(thread);
  if (old && now - old.refreshedAt < 15000) return true;
  if (!old && leases.size >= 128) return false;
  leases.set(thread, { refreshedAt: now, until: now + 60000 });
  return true;
}
export function organizationEngagedUntil(
  sql: SqlClient.SqlClient,
  thread: string,
  now = Date.now(),
): number | undefined {
  let maximum = 0;
  for (const leases of registries.get(sql)?.values() ?? []) {
    const lease = leases.get(thread);
    if (lease && lease.until > now && lease.refreshedAt <= now)
      maximum = Math.max(maximum, lease.until);
  }
  return maximum || undefined;
}
export function forgetOrganizationEngagementCaller(caller: string): void {
  callers.get(caller)?.clear();
  callers.delete(caller);
}
