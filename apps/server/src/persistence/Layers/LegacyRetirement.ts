import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable record of the Build A drain (U5/U8). The record lists the exact panes A
 * drained and the pending items it could not settle. The marker is written by the
 * same transaction and is the only fact B may act on: a missing marker means A was
 * not drained, regardless of sockets or processes.
 *
 * @module LegacyRetirement
 */

export type LegacyRetirementDecision = "save-and-close" | "drain-now";

export interface LegacyRetirementInput {
  readonly profileScope: string;
  /** The Build A artifact that ran the drain. */
  readonly artifactId: string;
  readonly decision: LegacyRetirementDecision;
  /** Exact pane identities (thread/terminal/lease) that were closed. */
  readonly drainedLeases: ReadonlyArray<string>;
  /** Items the drain could not settle; a non-empty list fences B. */
  readonly pendingItems: ReadonlyArray<string>;
}

export interface LegacyRetirementMarker {
  readonly profileScope: string;
  readonly artifactId: string;
  readonly recordedAt: number;
}

export interface LegacyRetirementRecord extends LegacyRetirementInput {
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type LegacyRetirementWrite = "committed" | "already-retired" | "conflict";

export class LegacyRetirementCheckpointError extends Data.TaggedError(
  "LegacyRetirementCheckpointError",
)<{ readonly detail: string }> {}

const parseList = (value: string): ReadonlyArray<string> => {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string"))
    throw new Error("The legacy retirement record contains a malformed list.");
  return parsed as ReadonlyArray<string>;
};

/** Reads the marker and record together; either absent is `undefined`. */
export const readLegacyRetirement = Effect.fn("readLegacyRetirement")(function* (
  sql: SqlClient.SqlClient,
  profileScope: string,
) {
  const [record] = yield* sql<{
    readonly profileScope: string;
    readonly artifactId: string;
    readonly decision: LegacyRetirementDecision;
    readonly drainedLeases: string;
    readonly pendingItems: string;
    readonly createdAt: number;
    readonly updatedAt: number;
  }>`
    SELECT profile_scope AS profileScope, artifact_id AS artifactId, decision,
      drained_leases AS drainedLeases, pending_items AS pendingItems,
      created_at AS createdAt, updated_at AS updatedAt
    FROM ssh_legacy_retirement WHERE profile_scope = ${profileScope}
  `;
  const [marker] = yield* sql<{
    readonly profileScope: string;
    readonly artifactId: string;
    readonly recordedAt: number;
  }>`
    SELECT profile_scope AS profileScope, artifact_id AS artifactId, recorded_at AS recordedAt
    FROM ssh_legacy_retired_marker WHERE profile_scope = ${profileScope}
  `;
  if (!record || !marker) return undefined;
  return {
    record: {
      ...record,
      drainedLeases: parseList(record.drainedLeases),
      pendingItems: parseList(record.pendingItems),
    } satisfies LegacyRetirementRecord,
    marker,
  };
});

export const readLegacyRetirementMarker = Effect.fn("readLegacyRetirementMarker")(function* (
  sql: SqlClient.SqlClient,
  profileScope: string,
) {
  const [marker] = yield* sql<{
    readonly profileScope: string;
    readonly artifactId: string;
    readonly recordedAt: number;
  }>`
    SELECT profile_scope AS profileScope, artifact_id AS artifactId, recorded_at AS recordedAt
    FROM ssh_legacy_retired_marker WHERE profile_scope = ${profileScope}
  `;
  return marker satisfies LegacyRetirementMarker | undefined;
});

/**
 * Writes the retirement record and marker in one transaction. A marker never
 * exists without its record (foreign key). Re-running with the same artifact is
 * idempotent; a different artifact after retirement is a conflict and changes
 * nothing.
 */
export const writeLegacyRetirementTransaction = Effect.fn("writeLegacyRetirementTransaction")(
  function* (sql: SqlClient.SqlClient, input: LegacyRetirementInput) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const marker = yield* readLegacyRetirementMarker(sql, input.profileScope);
        if (marker) {
          return marker.artifactId === input.artifactId
            ? ("already-retired" as const)
            : ("conflict" as const);
        }
        yield* sql`
          INSERT INTO ssh_legacy_retirement
            (profile_scope, artifact_id, decision, drained_leases, pending_items,
              created_at, updated_at)
          VALUES (${input.profileScope}, ${input.artifactId}, ${input.decision},
            ${JSON.stringify(input.drainedLeases)}, ${JSON.stringify(input.pendingItems)},
            ${now}, ${now})
        `;
        yield* sql`
          INSERT INTO ssh_legacy_retired_marker (profile_scope, artifact_id, recorded_at)
          VALUES (${input.profileScope}, ${input.artifactId}, ${now})
        `;
        return "committed" as const;
      }),
    );
  },
);

/** `PRAGMA wal_checkpoint(TRUNCATE)` after the commit, before the lock is released. */
export const checkpointLegacyRetirementWal = Effect.fn("checkpointLegacyRetirementWal")(function* (
  sql: SqlClient.SqlClient,
) {
  const [checkpoint] = yield* sql<{
    readonly busy: number;
    readonly log: number;
    readonly checkpointed: number;
  }>`PRAGMA wal_checkpoint(TRUNCATE)`;
  if (checkpoint !== undefined && checkpoint.busy !== 0) {
    return yield* new LegacyRetirementCheckpointError({
      detail:
        "A reader held the WAL open; the retirement marker is committed but not checkpointed.",
    });
  }
});

/**
 * The full durable step: one transaction, then a bounded WAL checkpoint. Callers
 * release the backend lock only after this completes.
 */
export const commitLegacyRetirement = Effect.fn("commitLegacyRetirement")(function* (
  sql: SqlClient.SqlClient,
  input: LegacyRetirementInput,
) {
  const result = yield* writeLegacyRetirementTransaction(sql, input);
  if (result === "conflict") return result;
  yield* checkpointLegacyRetirementWal(sql);
  return result;
});
