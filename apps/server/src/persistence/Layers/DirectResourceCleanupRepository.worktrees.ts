import { createHash } from "node:crypto";

import { Data, Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { DirectResourceCleanupRepositoryShape } from "../Services/DirectResourceCleanupRepository.ts";
import {
  PurgeResource,
  type PurgeResource as PurgeResourceType,
} from "../Services/PurgeJobRepository.ts";

class WorktreeManifestDecodeError extends Data.TaggedError("WorktreeManifestDecodeError")<{
  readonly cause: unknown;
}> {}

export function serializeManagedWorktreeResource(resource: unknown): {
  readonly resource: PurgeResourceType;
  readonly json: string;
  readonly digest: string;
} {
  const normalized = Schema.decodeUnknownSync(PurgeResource)(resource);
  const segments = normalized.relativePath.split(/[\\/]/u);
  if (
    normalized.kind !== "managed-worktree" ||
    normalized.action !== "delete" ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    normalized.quarantineName === null ||
    !normalized.quarantineName.startsWith(".bigbud-purge-") ||
    normalized.quarantineName.includes("/") ||
    normalized.quarantineName.includes("\\")
  ) {
    throw new Error("cleanup worktree manifest contains an invalid resource");
  }
  const json = JSON.stringify(normalized);
  return {
    resource: normalized,
    json,
    digest: createHash("sha256").update(json).digest("hex"),
  };
}

export function makeDirectResourceCleanupWorktrees(
  sql: SqlClient.SqlClient,
): Pick<
  DirectResourceCleanupRepositoryShape,
  "listEligibleWorktrees" | "completeWorktree" | "retryWorktree" | "blockWorktree"
> {
  return {
    listEligibleWorktrees: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{
              readonly operationId: string;
              readonly resourceId: string;
              readonly resourceJson: string;
              readonly resourceDigest: string;
              readonly attemptCount: number;
            }>`
              SELECT worktree.operation_id AS "operationId",
                worktree.resource_id AS "resourceId", worktree.resource_json AS "resourceJson",
                worktree.resource_digest AS "resourceDigest",
                worktree.attempt_count AS "attemptCount"
              FROM direct_resource_cleanup_worktrees AS worktree
              JOIN direct_resource_cleanup_plans AS plan
                ON plan.operation_id = worktree.operation_id
              JOIN direct_resource_cleanup_proofs AS proof
                ON proof.operation_id = worktree.operation_id
              WHERE worktree.state IN ('pending', 'retry')
                AND (worktree.next_attempt_at IS NULL OR worktree.next_attempt_at <= ${input.dueAt})
                AND (${input.operationId ?? null} IS NULL OR worktree.operation_id = ${input.operationId ?? null})
                AND (proof.aggregate_kind = 'project' OR proof.canonical_pruned_at IS NOT NULL)
                AND plan.state <> 'cancelled'
              ORDER BY plan.created_at, worktree.operation_id, worktree.original_index
              LIMIT ${Math.max(1, Math.min(100, Math.floor(input.limit)))}
            `;
            const candidates = [];
            for (const row of rows) {
              const decoded = yield* Effect.exit(
                Effect.try({
                  try: () => serializeManagedWorktreeResource(JSON.parse(row.resourceJson)),
                  catch: (cause) => new WorktreeManifestDecodeError({ cause }),
                }),
              );
              if (
                decoded._tag === "Failure" ||
                decoded.value.json !== row.resourceJson ||
                decoded.value.digest !== row.resourceDigest
              ) {
                yield* sql`
                  UPDATE direct_resource_cleanup_worktrees
                  SET state = 'blocked', next_attempt_at = NULL,
                    last_error_code = 'invalid_manifest', updated_at = ${input.dueAt}
                  WHERE operation_id = ${row.operationId} AND resource_id = ${row.resourceId}
                    AND state IN ('pending', 'retry') AND attempt_count = ${row.attemptCount}
                `;
                continue;
              }
              candidates.push({
                operationId: row.operationId,
                resourceId: row.resourceId,
                resource: decoded.value.resource,
                attemptCount: row.attemptCount,
              });
            }
            return candidates;
          }),
        )
        .pipe(Effect.mapError((error) => new Error(String(error)))),
    completeWorktree: (input) =>
      sql`
        UPDATE direct_resource_cleanup_worktrees
        SET state = 'completed', completed_at = ${input.completedAt}, next_attempt_at = NULL,
          last_error_code = NULL, updated_at = ${input.completedAt}
        WHERE operation_id = ${input.operationId} AND resource_id = ${input.resourceId}
          AND state IN ('pending', 'retry') AND attempt_count = ${input.expectedAttemptCount}
        RETURNING resource_id
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError((error) => new Error(String(error))),
      ),
    retryWorktree: (input) =>
      sql`
        UPDATE direct_resource_cleanup_worktrees
        SET state = 'retry', attempt_count = attempt_count + 1,
          next_attempt_at = ${input.nextAttemptAt}, last_error_code = ${input.errorCode},
          updated_at = ${input.updatedAt}
        WHERE operation_id = ${input.operationId} AND resource_id = ${input.resourceId}
          AND state IN ('pending', 'retry') AND attempt_count = ${input.expectedAttemptCount}
        RETURNING resource_id
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError((error) => new Error(String(error))),
      ),
    blockWorktree: (input) =>
      sql`
        UPDATE direct_resource_cleanup_worktrees
        SET state = 'blocked', attempt_count = attempt_count + 1, next_attempt_at = NULL,
          last_error_code = ${input.errorCode}, updated_at = ${input.updatedAt}
        WHERE operation_id = ${input.operationId} AND resource_id = ${input.resourceId}
          AND state IN ('pending', 'retry') AND attempt_count = ${input.expectedAttemptCount}
        RETURNING resource_id
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError((error) => new Error(String(error))),
      ),
  };
}
