import type { ThreadRetentionAgeCriterion } from "@bigbud/contracts/core/settings.threadRetention.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ThreadRetentionExclusionSummary,
  type ThreadRetentionExclusionReason,
} from "../Services/ThreadRetentionRepository.models.ts";
import type { ThreadRetentionRepositoryShape } from "../Services/ThreadRetentionRepository.shape.ts";
import {
  retentionAgeSql,
  retentionExclusionCaseSql,
  retentionVisibleActivitySql,
} from "./ThreadRetentionRepository.eligibility.ts";
import { retentionSubtreeCteSql } from "./ThreadRetentionRepository.pages.ts";

export type RetentionExclusionOptions = {
  readonly selectionMode: "legacy-subtree" | "per-thread";
  readonly ageCriterion: ThreadRetentionAgeCriterion;
};

/**
 * An old legacy root with no blocker of its own that its subtree still holds back: a
 * descendant is newer than the cutoff, or excluded for its own reason. Per-thread mode has
 * no subtree propagation, so this applies to legacy subtree selection only.
 */
const blockedByDescendantSql = `${retentionSubtreeCteSql}
  SELECT COUNT(*) AS count FROM projection_threads AS t
  JOIN subtree_activity AS activity ON activity.root_thread_id = t.thread_id
  WHERE ${retentionVisibleActivitySql("t")} <= ?
    AND (${retentionExclusionCaseSql("t")}) IS NULL
    AND (activity.last_activity_at > ? OR EXISTS (
      SELECT 1 FROM subtree_exclusion_candidates AS held
      WHERE held.root_thread_id = t.thread_id AND held.thread_id <> t.thread_id
        AND held.reason IS NOT NULL
    ))`;

/**
 * The selector's own breakdown of threads at or past the cutoff: one reason per thread, the
 * same CASE the selection pages use. Shared by the Settings preview and by each run's record.
 */
export function makeRetentionExclusionSummary(sql: SqlClient.SqlClient) {
  return Effect.fn("ThreadRetentionRepository.exclusionSummary")(function* (
    cutoffAt: string,
    options?: RetentionExclusionOptions,
  ) {
    const perThread = options?.selectionMode === "per-thread";
    const age = perThread
      ? retentionAgeSql("t", options?.ageCriterion ?? "last-conversation-activity")
      : retentionVisibleActivitySql("t");
    const reason = perThread
      ? retentionExclusionCaseSql("t", "per-thread")
      : retentionExclusionCaseSql("t");
    const groups = yield* sql.unsafe<{
      reason: ThreadRetentionExclusionReason | null;
      count: number;
    }>(
      `SELECT reason, COUNT(*) AS count FROM (
        SELECT ${reason} AS reason FROM projection_threads AS t WHERE ${age} <= ?
      ) GROUP BY reason ORDER BY reason ASC`,
      [cutoffAt],
    );
    const blockedByDescendant = perThread
      ? 0
      : ((yield* sql.unsafe<{ count: number }>(blockedByDescendantSql, [cutoffAt, cutoffAt]))[0]
          ?.count ?? 0);
    const exclusionCounts = groups.flatMap((row) =>
      row.reason === null ? [] : [{ reason: row.reason, count: row.count }],
    );
    if (blockedByDescendant > 0) {
      exclusionCounts.push({ reason: "blocked_by_descendant", count: blockedByDescendant });
      exclusionCounts.sort((left, right) =>
        left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0,
      );
    }
    return {
      // Soft-deleted rows are not threads the user can see, so they are not "older threads".
      olderThanCutoffCount: groups
        .filter((row) => row.reason !== "already_deleted")
        .reduce((total, row) => total + row.count, 0),
      exclusionCounts,
    } satisfies ThreadRetentionExclusionSummary;
  });
}

export function makeRecordRunExclusionSummary(sql: SqlClient.SqlClient) {
  const summarize = makeRetentionExclusionSummary(sql);
  return Effect.fn("ThreadRetentionRepository.recordRunExclusionSummary")(function* (
    input: Parameters<ThreadRetentionRepositoryShape["recordRunExclusionSummary"]>[0],
  ) {
    const summary = yield* summarize(input.cutoffAt, {
      selectionMode: input.selectionMode,
      ageCriterion: input.ageCriterion,
    });
    const rows = yield* sql`
      UPDATE thread_retention_runs SET exclusion_counts_json = ${JSON.stringify(summary)},
        updated_at = ${input.updatedAt}
      WHERE run_id = ${input.runId} AND active_slot = 1
      RETURNING run_id
    `;
    return rows.length === 1;
  });
}

const decodeSummary = Schema.decodeUnknownOption(
  Schema.fromJsonString(ThreadRetentionExclusionSummary),
);

/** Stored JSON from `exclusion_counts_json`; unreadable or missing records read as none. */
export function decodeRetentionExclusionSummary(
  json: string | null | undefined,
): ThreadRetentionExclusionSummary | null {
  return typeof json === "string" ? Option.getOrNull(decodeSummary(json)) : null;
}
