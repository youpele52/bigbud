import { ThreadId } from "@bigbud/contracts";
import { Cause, Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { verifyCanonicalPurgeProof } from "./EntityPurge.proof.ts";
import { makeEntityPurgeSql } from "./EntityPurge.sql.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../../orchestration/Services/ProjectionPipeline.ts";

export const CANONICAL_THREAD_CLEANUP_LIMIT = 50;

export interface DeferredCanonicalThreadCleanupCandidate {
  readonly threadId: ThreadId;
  readonly deletionSequence: number;
  readonly covered: boolean;
}

interface DeferredCanonicalThreadCleanupCandidateRow extends Omit<
  DeferredCanonicalThreadCleanupCandidate,
  "covered"
> {
  readonly covered: number;
}

export interface DeferredCanonicalThreadCleanupResult {
  readonly cleanedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly candidates: ReadonlyArray<
    DeferredCanonicalThreadCleanupCandidate & {
      readonly outcome: "cleaned" | "skipped" | "failed";
      readonly detail?: string;
    }
  >;
}

export function listDeferredCanonicalThreadCleanupCandidates(
  sql: SqlClient.SqlClient,
  limit = CANONICAL_THREAD_CLEANUP_LIMIT,
) {
  return sql<DeferredCanonicalThreadCleanupCandidateRow>`
    WITH roots AS (
      SELECT marker.entity_id AS "threadId",
        marker.deletion_sequence AS "deletionSequence"
      FROM orchestration_deletion_markers AS marker
      JOIN orchestration_events AS deletion
        ON deletion.sequence = marker.deletion_sequence
       AND deletion.aggregate_kind = 'thread'
       AND deletion.stream_id = marker.entity_id
       AND deletion.event_type = 'thread.deleted'
      WHERE marker.entity_kind = 'thread'
    )
    SELECT roots."threadId", roots."deletionSequence", 1 AS covered
    FROM roots
    WHERE NOT EXISTS (
        SELECT 1
        FROM orchestration_deletion_markers AS marker
        LEFT JOIN projection_baselines AS baseline
          ON baseline.sequence = marker.covered_by_baseline_sequence
         AND baseline.verification_status = 'verified'
        WHERE marker.entity_kind = 'thread'
          AND marker.deletion_sequence = roots."deletionSequence"
          AND baseline.sequence IS NULL
       )
    GROUP BY roots."threadId", roots."deletionSequence"
    ORDER BY roots."deletionSequence" ASC
    LIMIT ${Math.min(CANONICAL_THREAD_CLEANUP_LIMIT, Math.max(1, Math.floor(limit)))}
  `.pipe(Effect.map((rows) => rows.map((row) => ({ ...row, covered: row.covered === 1 }))));
}

export const finalizeThreadCanonicalHistory = Effect.fn("finalizeThreadCanonicalHistory")(
  function* (input: {
    readonly projectionPipeline: OrchestrationProjectionPipelineShape;
    readonly sql: SqlClient.SqlClient;
    readonly threadId: ThreadId;
    readonly deletionSequence: number;
  }) {
    const verifyReplacement =
      input.projectionPipeline.ensureVerifiedBaselineThroughWithoutCompaction;
    if (verifyReplacement === undefined) {
      return yield* Effect.fail(
        new Error("verify-only projection baseline support is unavailable"),
      );
    }
    yield* verifyReplacement(input.deletionSequence);
    const queries = makeEntityPurgeSql(input.sql);
    yield* input.sql.withTransaction(
      Effect.gen(function* () {
        yield* verifyCanonicalPurgeProof({
          queries,
          entityKind: "thread",
          entityId: input.threadId,
        });
        yield* queries.deleteProvenReceipts({ entityKind: "thread", entityId: input.threadId });
        yield* queries.deleteProvenThreadCanonical({ threadId: input.threadId });
      }),
    );
  },
);

export function makeDeferredCanonicalThreadCleanup<E>(input: {
  readonly listCandidates: () => Effect.Effect<
    ReadonlyArray<DeferredCanonicalThreadCleanupCandidate>,
    E
  >;
  readonly finalize: (candidate: DeferredCanonicalThreadCleanupCandidate) => Effect.Effect<void, E>;
}) {
  return Effect.fn("runDeferredCanonicalThreadCleanup")(function* (apply: boolean) {
    const candidates = yield* input.listCandidates();
    if (!apply) {
      return {
        cleanedCount: 0,
        skippedCount: candidates.length,
        failedCount: 0,
        candidates: candidates.map((candidate) => ({ ...candidate, outcome: "skipped" as const })),
      } satisfies DeferredCanonicalThreadCleanupResult;
    }

    const outcomes = yield* Effect.forEach(
      candidates,
      (candidate) =>
        (candidate.covered ? input.finalize(candidate) : Effect.void).pipe(
          Effect.exit,
          Effect.map((exit) =>
            !candidate.covered
              ? {
                  ...candidate,
                  outcome: "skipped" as const,
                  detail: "no verified baseline coverage",
                }
              : exit._tag === "Success"
                ? { ...candidate, outcome: "cleaned" as const }
                : {
                    ...candidate,
                    outcome: "failed" as const,
                    detail: Cause.pretty(exit.cause),
                  },
          ),
        ),
      { concurrency: 1 },
    );
    return {
      cleanedCount: outcomes.filter((outcome) => outcome.outcome === "cleaned").length,
      skippedCount: outcomes.filter((outcome) => outcome.outcome === "skipped").length,
      failedCount: outcomes.filter((outcome) => outcome.outcome === "failed").length,
      candidates: outcomes,
    } satisfies DeferredCanonicalThreadCleanupResult;
  });
}

export const runDeferredCanonicalThreadCleanup = Effect.fn("runDeferredCanonicalThreadCleanup")(
  function* (apply: boolean, limit: number) {
    const sql = yield* SqlClient.SqlClient;
    const projectionPipeline = yield* OrchestrationProjectionPipeline;
    return yield* makeDeferredCanonicalThreadCleanup({
      listCandidates: () => listDeferredCanonicalThreadCleanupCandidates(sql, limit),
      finalize: (candidate) =>
        finalizeThreadCanonicalHistory({
          projectionPipeline,
          sql,
          threadId: candidate.threadId,
          deletionSequence: candidate.deletionSequence,
        }),
    })(apply);
  },
);
