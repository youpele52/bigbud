import {
  ServerThreadRetentionError,
  type ThreadRetentionMaintenanceState,
} from "@bigbud/contracts/server/threadRetention.ts";
import { Effect, Schema } from "effect";

import {
  increment,
  threadRetentionEligibilityMetricAttributes,
  threadRetentionEligibilityTotal,
  threadRetentionManagedBytes,
  threadRetentionManagedResources,
  threadRetentionPreviewDuration,
  withMetrics,
} from "../../observability/Metrics.ts";
import type { ThreadRetentionRepositoryShape } from "../../persistence/Services/ThreadRetentionRepository.ts";
import type { PurgeJobRepositoryShape } from "../../persistence/Services/PurgeJobRepository.ts";
import type { ThreadRetentionShape } from "../Services/ThreadRetention.ts";
import { cutoffForRetentionPolicy } from "./ThreadRetention.logic.ts";

const CHALLENGE_TTL_MS = 5 * 60 * 1_000;
const PURGE_BACKLOG_LIMIT = 100;

const retentionError = (code: ServerThreadRetentionError["code"], message: string) =>
  new ServerThreadRetentionError({ code, message });

export function deriveThreadRetentionMaintenanceState(input: {
  readonly activeRun?:
    | { readonly trigger: "manual" | "scheduled"; readonly status: string }
    | undefined;
  readonly purgeBacklog: number;
  readonly purgeBacklogLimit: number;
}): ThreadRetentionMaintenanceState {
  if (input.activeRun?.status === "deferred" || input.purgeBacklog >= input.purgeBacklogLimit) {
    return "safety_deferred";
  }
  if (input.activeRun?.trigger === "manual") return "manual_active";
  if (input.activeRun) return "scheduled_active";
  return "available";
}

export function makeThreadRetentionPreview(input: {
  readonly repository: ThreadRetentionRepositoryShape;
  readonly purgeJobs: Pick<PurgeJobRepositoryShape, "countIncomplete">;
}): ThreadRetentionShape["preview"] {
  return (request) =>
    Effect.gen(function* () {
      if (process.env.BIGBUD_DISABLE_THREAD_RETENTION === "1") {
        return yield* retentionError(
          "disabled",
          "Thread retention is disabled by the server administrator.",
        );
      }
      const generatedAtMs = Date.now();
      const generatedAt = new Date(generatedAtMs).toISOString();
      const cutoffAt = cutoffForRetentionPolicy(request.policy, generatedAtMs);
      const result = yield* input.repository.preview(cutoffAt);
      yield* increment(
        threadRetentionEligibilityTotal,
        threadRetentionEligibilityMetricAttributes("eligible"),
        result.eligibleCount,
      );
      yield* Effect.forEach(
        result.exclusionCounts,
        (excluded) =>
          increment(
            threadRetentionEligibilityTotal,
            threadRetentionEligibilityMetricAttributes(excluded.reason),
            excluded.count,
          ),
        { discard: true },
      );
      yield* increment(threadRetentionManagedResources, {}, result.estimatedResourceCount);
      yield* increment(threadRetentionManagedBytes, {}, result.estimatedKnownBytes);
      const challenge = yield* input.repository.issueChallenge({
        challengeId: crypto.randomUUID(),
        trigger: request.trigger,
        policy: request.policy,
        cutoffAt,
        issuedAt: generatedAt,
        expiresAt: new Date(generatedAtMs + CHALLENGE_TTL_MS).toISOString(),
      });
      const active = yield* input.repository.listRecoverableRuns(1);
      const purgeBacklog = yield* input.purgeJobs.countIncomplete();
      const activeRun = active[0];
      const maintenanceState = deriveThreadRetentionMaintenanceState({
        activeRun,
        purgeBacklog,
        purgeBacklogLimit: PURGE_BACKLOG_LIMIT,
      });
      return {
        generatedAt,
        policy: request.policy,
        cutoffAt,
        ...result,
        maintenanceState,
        warnings: ["Resource estimates are bounded and may be incomplete."],
        challenge: {
          token: challenge.token,
          trigger: challenge.trigger,
          policy: challenge.policy,
          cutoffAt: challenge.cutoffAt,
          expiresAt: challenge.expiresAt,
          singleUse: true as const,
        },
      };
    }).pipe(
      withMetrics({
        timer: threadRetentionPreviewDuration,
        attributes: { trigger: request.trigger, policy: request.policy },
      }),
      Effect.mapError((error) =>
        Schema.is(ServerThreadRetentionError)(error)
          ? error
          : retentionError("failed", "Failed to preview thread retention."),
      ),
    );
}
