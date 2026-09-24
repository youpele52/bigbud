import type { ServerThreadRetentionRun } from "@bigbud/contracts/server/threadRetention.ts";
import type { ThreadRetentionRun } from "../../persistence/Services/ThreadRetentionRepository.ts";
import type { RetentionResourceSummary } from "../../persistence/Layers/ThreadRetentionRepository.resourceSummary.ts";

export function toServerThreadRetentionRun(
  run: ThreadRetentionRun,
  resources?: RetentionResourceSummary,
): ServerThreadRetentionRun {
  return {
    runId: run.runId,
    trigger: run.trigger,
    policy: run.policy,
    selectionMode: run.selectionMode ?? "legacy-subtree",
    ageCriterion: run.ageCriterion ?? "last-conversation-activity",
    cutoffAt: run.cutoffAt,
    status: run.status,
    eligibleCount: run.eligibleCount,
    selectedCount: run.selectedCount,
    requestedCount: run.requestedCount,
    uncertainCount: run.uncertainCount ?? 0,
    completedCount: run.completedCount,
    skippedCount: run.skippedCount,
    failedCount: run.failedCount,
    removableResourceCount: resources?.removableResourceCount ?? 0,
    completedResourceCount: resources?.completedResourceCount ?? 0,
    retainedResourceCount: resources?.retainedResourceCount ?? 0,
    retainedSharedResourceCount: resources?.retainedSharedResourceCount ?? 0,
    retainedExternalResourceCount: resources?.retainedExternalResourceCount ?? 0,
    unverifiedResourceCount: resources?.unverifiedResourceCount ?? 0,
    pendingResourceCount: resources?.pendingResourceCount ?? 0,
    blockedResourceCount: resources?.blockedResourceCount ?? 0,
    canonicalPendingCount: resources?.canonicalPendingCount ?? 0,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    deferredReason: run.lastErrorCode,
    errorMessage: run.status === "failed" ? run.lastErrorCode : null,
  };
}
