import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** Explicit recovery requests for a paused organiser (deliberate move, retry). Carries no facts
 * and never schedules: it only lets the lifecycle start a fresh native attempt sooner.
 */
const listeners = new WeakMap<SqlClient.SqlClient, Set<() => void>>();

export function requestOrganizationRecovery(sql: SqlClient.SqlClient) {
  for (const listener of listeners.get(sql) ?? []) listener();
}

export function awaitOrganizationRecovery(sql: SqlClient.SqlClient): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    const set = listeners.get(sql) ?? new Set<() => void>();
    listeners.set(sql, set);
    const listener = () => {
      set.delete(listener);
      resume(Effect.void);
    };
    set.add(listener);
    return Effect.sync(() => set.delete(listener));
  });
}
