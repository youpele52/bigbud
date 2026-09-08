import { Data, Effect } from "effect";

import type { DirectResourceCleanupRepositoryShape } from "../../persistence/Services/DirectResourceCleanupRepository.ts";
import type { ServerConfigShape } from "../../startup/config.ts";
import { deleteResourceAtomically, resolvePurgeResource } from "./EntityPurge.resources.ts";

export const MAX_WORKTREE_CLEANUP_ATTEMPTS = 5;

class WorktreeCleanupError extends Data.TaggedError("WorktreeCleanupError")<{
  readonly cause: unknown;
}> {}

type WorktreeRepository = Pick<
  DirectResourceCleanupRepositoryShape,
  "listEligibleWorktrees" | "completeWorktree" | "retryWorktree" | "blockWorktree"
>;

function cleanupErrorCode(error: unknown): string {
  const detail = String(error instanceof WorktreeCleanupError ? error.cause : error).toLowerCase();
  if (
    detail.includes("identity") ||
    detail.includes("unsafe") ||
    detail.includes("escape") ||
    detail.includes("symlink") ||
    detail.includes("unsupported") ||
    detail.includes("collision") ||
    detail.includes("appeared after")
  ) {
    return "safety_validation_failed";
  }
  return "filesystem_failure";
}

export const recoverDirectCleanupWorktrees = Effect.fn(
  "DirectResourceCleanupRecovery.recoverWorktrees",
)(function* (input: {
  readonly repository: WorktreeRepository;
  readonly config: ServerConfigShape;
  readonly operationId?: string;
}) {
  const dueAt = new Date().toISOString();
  const candidates = yield* input.repository.listEligibleWorktrees({
    dueAt,
    limit: 100,
    ...(input.operationId ? { operationId: input.operationId } : {}),
  });
  yield* Effect.forEach(
    candidates,
    (candidate) =>
      Effect.tryPromise({
        try: () =>
          deleteResourceAtomically({
            jobId: candidate.operationId,
            resolved: resolvePurgeResource(input.config, candidate.resource),
            resource: candidate.resource,
          }),
        catch: (cause) => new WorktreeCleanupError({ cause }),
      }).pipe(
        Effect.flatMap(() =>
          input.repository.completeWorktree({
            operationId: candidate.operationId,
            resourceId: candidate.resourceId,
            expectedAttemptCount: candidate.attemptCount,
            completedAt: new Date().toISOString(),
          }),
        ),
        Effect.catch((error) => {
          const errorCode = cleanupErrorCode(error);
          const updatedAt = new Date().toISOString();
          const shouldBlock =
            errorCode === "safety_validation_failed" ||
            candidate.attemptCount + 1 >= MAX_WORKTREE_CLEANUP_ATTEMPTS;
          return (
            shouldBlock
              ? input.repository.blockWorktree({
                  operationId: candidate.operationId,
                  resourceId: candidate.resourceId,
                  expectedAttemptCount: candidate.attemptCount,
                  errorCode:
                    errorCode === "safety_validation_failed" ? errorCode : "retry_budget_exhausted",
                  updatedAt,
                })
              : input.repository.retryWorktree({
                  operationId: candidate.operationId,
                  resourceId: candidate.resourceId,
                  expectedAttemptCount: candidate.attemptCount,
                  errorCode,
                  nextAttemptAt: new Date(Date.now() + 5_000).toISOString(),
                  updatedAt,
                })
          ).pipe(
            Effect.catch((persistenceError) =>
              Effect.logWarning("managed worktree cleanup state update failed", {
                operationId: candidate.operationId,
                resourceId: candidate.resourceId,
                detail: String(persistenceError),
              }),
            ),
          );
        }),
        Effect.asVoid,
      ),
    { concurrency: 1, discard: true },
  );
});
