import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { checkpointLegacyRetirementWal } from "./LegacyRetirement.ts";

/**
 * Durable record of a Build B drain (cutover §d step 1). B runs no legacy SSH, so it
 * never writes the Build A marker; it records its own retirement as one `retired`
 * row of `ssh_owner_retirement` (migration 184) under the legacy profile scope and a
 * reserved target. A retired row is never listed as unresolved, so neither a later B
 * nor A′ (whose only reader is the unresolved-row hydration list) acts on it; A′'s
 * startup reads only its own marker tables (migration 185).
 *
 * @module OwnerBuildRetirement
 */

/** Reserved target id; real targets are `ssh:*` ids keyed by the state directory. */
export const OWNER_BUILD_RETIREMENT_TARGET = "owner-build-drain";

export interface OwnerBuildRetirementOwner {
  readonly masters: number;
  readonly leases: number;
  readonly attachCleared: boolean;
}

export interface OwnerBuildRetirementInput {
  readonly profileScope: string;
  /** The Build B artifact that ran the drain. */
  readonly artifactId: string;
  readonly decision: "save-and-close" | "drain-now";
  /** Exact pane identities (thread/terminal/lease) the drain closed. */
  readonly drainedLeases: ReadonlyArray<string>;
  /** Hex owner epoch of the owner that shut down; empty when no owner was live. */
  readonly ownerEpoch: string;
  /** The owner's own shutdown report; absent when no owner was live. */
  readonly owner?: OwnerBuildRetirementOwner | undefined;
}

export interface OwnerBuildRetirementRecord extends OwnerBuildRetirementInput {
  readonly owner: OwnerBuildRetirementOwner | undefined;
  readonly recordedAt: number;
}

export class OwnerBuildRetirementConflictError extends Data.TaggedError(
  "OwnerBuildRetirementConflictError",
)<{ readonly detail: string }> {}

interface Detail {
  readonly v: 1;
  readonly kind: "owner-build-drain";
  readonly artifactId: string;
  readonly decision: OwnerBuildRetirementInput["decision"];
  readonly drainedLeases: ReadonlyArray<string>;
  readonly owner: OwnerBuildRetirementOwner | null;
}

const isCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

const parseDetail = (value: string): Detail => {
  const parsed = JSON.parse(value) as Partial<Detail> | null;
  const owner = parsed?.owner;
  if (
    parsed?.v !== 1 ||
    parsed.kind !== "owner-build-drain" ||
    typeof parsed.artifactId !== "string" ||
    (parsed.decision !== "save-and-close" && parsed.decision !== "drain-now") ||
    !Array.isArray(parsed.drainedLeases) ||
    parsed.drainedLeases.some((item) => typeof item !== "string") ||
    (owner !== null &&
      (typeof owner !== "object" ||
        !isCount(owner.masters) ||
        !isCount(owner.leases) ||
        typeof owner.attachCleared !== "boolean"))
  )
    throw new Error("The Build B retirement record is malformed.");
  return parsed as Detail;
};

/** Upserts the retired row; an unresolved row under the reserved key is never replaced. */
export const writeOwnerBuildRetirement = Effect.fn("writeOwnerBuildRetirement")(function* (
  sql: SqlClient.SqlClient,
  input: OwnerBuildRetirementInput,
) {
  const now = yield* Clock.currentTimeMillis;
  const detail = JSON.stringify({
    v: 1,
    kind: "owner-build-drain",
    artifactId: input.artifactId,
    decision: input.decision,
    drainedLeases: input.drainedLeases,
    owner: input.owner ?? null,
  } satisfies Detail);
  const [row] = yield* sql<{ readonly state: string }>`
    INSERT INTO ssh_owner_retirement
      (profile_scope, target_id, owner_epoch, generation, state, pid, start_time, namespace,
        detail, updated_at)
    VALUES (${input.profileScope}, ${OWNER_BUILD_RETIREMENT_TARGET}, ${input.ownerEpoch}, '',
      'retired', NULL, NULL, NULL, ${detail}, ${now})
    ON CONFLICT (profile_scope, target_id) DO UPDATE SET
      owner_epoch = excluded.owner_epoch, generation = '', state = 'retired', pid = NULL,
      start_time = NULL, namespace = NULL, detail = excluded.detail,
      updated_at = excluded.updated_at
    WHERE ssh_owner_retirement.state = 'retired'
    RETURNING state
  `;
  if (row === undefined)
    return yield* new OwnerBuildRetirementConflictError({
      detail: "An unresolved owner retirement row holds the Build B drain record's key.",
    });
});

export const readOwnerBuildRetirement = Effect.fn("readOwnerBuildRetirement")(function* (
  sql: SqlClient.SqlClient,
  profileScope: string,
) {
  const [row] = yield* sql<{
    readonly ownerEpoch: string;
    readonly detail: string;
    readonly updatedAt: number;
  }>`
    SELECT owner_epoch AS ownerEpoch, detail, updated_at AS updatedAt
    FROM ssh_owner_retirement
    WHERE profile_scope = ${profileScope} AND target_id = ${OWNER_BUILD_RETIREMENT_TARGET}
      AND state = 'retired'
  `;
  if (!row) return undefined;
  const detail = yield* Effect.try({
    try: () => parseDetail(row.detail),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
  return {
    profileScope,
    artifactId: detail.artifactId,
    decision: detail.decision,
    drainedLeases: detail.drainedLeases,
    ownerEpoch: row.ownerEpoch,
    owner: detail.owner ?? undefined,
    recordedAt: row.updatedAt,
  } satisfies OwnerBuildRetirementRecord;
});

/**
 * The durable step: the record in one transaction, then the bounded WAL checkpoint.
 * The caller releases the backend lock only after this completes.
 */
export const commitOwnerBuildRetirement = Effect.fn("commitOwnerBuildRetirement")(function* (
  sql: SqlClient.SqlClient,
  input: OwnerBuildRetirementInput,
) {
  yield* sql.withTransaction(writeOwnerBuildRetirement(sql, input));
  yield* checkpointLegacyRetirementWal(sql);
  return "committed" as const;
});
