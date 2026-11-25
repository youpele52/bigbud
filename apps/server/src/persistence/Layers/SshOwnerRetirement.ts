import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export type SshOwnerRetirementState = "intent" | "bound" | "retired";

export interface SshOwnerRetirementRow {
  readonly profileScope: string;
  readonly targetId: string;
  readonly ownerEpoch: string;
  readonly generation: string;
  readonly state: SshOwnerRetirementState;
  readonly pid: number | null;
  readonly startTime: string | null;
  readonly namespace: string | null;
  readonly detail: string;
  readonly updatedAt: number;
}

export interface SshOwnerRetirementIntent {
  readonly profileScope: string;
  readonly targetId: string;
  readonly detail: string;
}

export interface SshOwnerRetirementBinding extends SshOwnerRetirementIntent {
  readonly ownerEpoch: string;
  /** Hex-encoded owner generation; never empty for a bound row. */
  readonly generation: string;
  /** Exact process identity when the backend has it; the owner journal is authoritative. */
  readonly pid?: number | null;
  /** Decimal process start time from the owner journal. */
  readonly startTime?: string | null;
  /** `dev:ino` on Linux; null where the platform has no PID namespaces. */
  readonly namespace?: string | null;
}

export type SshOwnerRetirementWrite =
  | "recorded"
  | "unresolved"
  | "conflict"
  | "retired"
  | "missing";

const columns = `profile_scope AS profileScope, target_id AS targetId,
  owner_epoch AS ownerEpoch, generation, state, pid,
  start_time AS startTime, namespace, detail, updated_at AS updatedAt`;

const select = (sql: SqlClient.SqlClient, profileScope: string, targetId: string) =>
  sql<SshOwnerRetirementRow>`
    SELECT ${sql.literal(columns)} FROM ssh_owner_retirement
    WHERE profile_scope = ${profileScope} AND target_id = ${targetId}
  `;

/**
 * Write the pre-spawn intent. An existing intent or bound row is unresolved
 * evidence and is never overwritten; only a retired row may be replaced.
 */
export const recordSshOwnerRetirementIntent = Effect.fn("recordSshOwnerRetirementIntent")(
  function* (sql: SqlClient.SqlClient, input: SshOwnerRetirementIntent) {
    const now = yield* Clock.currentTimeMillis;
    const [row] = yield* sql<{ state: SshOwnerRetirementState }>`
    INSERT INTO ssh_owner_retirement
      (profile_scope, target_id, owner_epoch, generation, state, pid, start_time, namespace,
        detail, updated_at)
    VALUES (${input.profileScope}, ${input.targetId}, '', '', 'intent', NULL, NULL, NULL,
      ${input.detail}, ${now})
    ON CONFLICT (profile_scope, target_id) DO UPDATE SET
      owner_epoch = '', generation = '', state = 'intent', pid = NULL,
      start_time = NULL, namespace = NULL, detail = excluded.detail,
      updated_at = excluded.updated_at
    WHERE ssh_owner_retirement.state = 'retired'
    RETURNING state
  `;
    return (row === undefined ? "unresolved" : "recorded") satisfies SshOwnerRetirementWrite;
  },
);

/**
 * Complete an existing intent with the exact process identity. A missing or
 * conflicting intent is refused rather than inferred from a PID.
 */
export const recordSshOwnerRetirementBinding = Effect.fn("recordSshOwnerRetirementBinding")(
  function* (sql: SqlClient.SqlClient, input: SshOwnerRetirementBinding) {
    const now = yield* Clock.currentTimeMillis;
    const [row] = yield* sql<{ state: SshOwnerRetirementState }>`
    UPDATE ssh_owner_retirement SET
      owner_epoch = ${input.ownerEpoch},
      generation = ${input.generation},
      state = 'bound',
      pid = ${input.pid ?? null},
      start_time = ${input.startTime ?? null},
      namespace = ${input.namespace ?? null},
      detail = ${input.detail},
      updated_at = ${now}
    WHERE profile_scope = ${input.profileScope}
      AND target_id = ${input.targetId}
      AND state = 'intent'
      AND owner_epoch = ''
    RETURNING state
  `;
    return (row === undefined ? "conflict" : "recorded") satisfies SshOwnerRetirementWrite;
  },
);

/** Mark verified absence/reap only. Idempotent; never resurrects a retired row. */
export const markSshOwnerRetirementRetired = Effect.fn("markSshOwnerRetirementRetired")(function* (
  sql: SqlClient.SqlClient,
  profileScope: string,
  targetId: string,
  detail: string,
) {
  const now = yield* Clock.currentTimeMillis;
  const [row] = yield* sql<{ state: SshOwnerRetirementState }>`
    UPDATE ssh_owner_retirement SET
      state = 'retired', pid = NULL, start_time = NULL, namespace = NULL,
      detail = ${detail}, updated_at = ${now}
    WHERE profile_scope = ${profileScope} AND target_id = ${targetId}
      AND state IN ('intent', 'bound')
    RETURNING state
  `;
  return (row === undefined ? "missing" : "retired") satisfies SshOwnerRetirementWrite;
});

/** Backend-visible unresolved rows for one profile. The owner journal decides admission. */
export const listUnresolvedSshOwnerRetirements = Effect.fn("listUnresolvedSshOwnerRetirements")(
  function* (sql: SqlClient.SqlClient, profileScope: string) {
    return yield* sql<SshOwnerRetirementRow>`
    SELECT ${sql.literal(columns)} FROM ssh_owner_retirement
    WHERE profile_scope = ${profileScope} AND state <> 'retired'
    ORDER BY target_id
  `;
  },
);

export const readSshOwnerRetirement = Effect.fn("readSshOwnerRetirement")(function* (
  sql: SqlClient.SqlClient,
  profileScope: string,
  targetId: string,
) {
  const [row] = yield* select(sql, profileScope, targetId);
  return row;
});
