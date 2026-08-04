import { CommandId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect, Option } from "effect";

import {
  increment,
  threadRetentionItemMetricAttributes,
  threadRetentionItemsTotal,
} from "../../observability/Metrics.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type {
  ThreadRetentionRepositoryShape,
  ThreadRetentionRun,
  ThreadRetentionRunItem,
} from "../../persistence/Services/ThreadRetentionRepository.ts";
import {
  RETENTION_PREPARATION_TIMEOUT_MS,
  runRetentionEffectWithinDeadline,
} from "./ThreadRetention.coordinator.helpers.ts";
import type { RetentionRuntimeCleanupResult } from "./ThreadRetention.cleanup.ts";

export function makeDispatchSelectedRetentionItems(input: {
  readonly repository: ThreadRetentionRepositoryShape;
  readonly orchestration: OrchestrationEngineShape;
  readonly retryRuntimeCleanup: (
    threadId: ThreadRetentionRunItem["threadId"],
  ) => Effect.Effect<RetentionRuntimeCleanupResult>;
  readonly selectionGate: (
    run: ThreadRetentionRun,
  ) => Effect.Effect<
    | "disabled"
    | "policy_never"
    | "policy_changed"
    | "provider_pressure"
    | { readonly reason: "recent_failures"; readonly wakeAt: string }
    | null
  >;
  readonly now: () => number;
}) {
  return Effect.fn("ThreadRetention.dispatchSelected")(function* (
    run: ThreadRetentionRun,
    items: ReadonlyArray<ThreadRetentionRunItem>,
    deadlineAt: number,
  ) {
    for (const item of items.filter((candidate) => candidate.status === "selected")) {
      if (input.now() >= deadlineAt) return "slice_budget" as const;
      const gateResult = yield* runRetentionEffectWithinDeadline({
        effect: input.selectionGate(run),
        deadlineAt,
        now: input.now,
        maxDurationMs: RETENTION_PREPARATION_TIMEOUT_MS,
      });
      if (Option.isNone(gateResult)) return "preparation_timeout" as const;
      const gate = gateResult.value;
      if (gate === "policy_never" || gate === "policy_changed") {
        const skipped = yield* input.repository.transitionItem({
          runId: run.runId,
          threadId: item.threadId,
          expectedStatuses: ["selected"],
          nextStatus: "skipped",
          exclusionReason: "policy_changed",
          updatedAt: new Date(input.now()).toISOString(),
        });
        if (skipped)
          yield* increment(
            threadRetentionItemsTotal,
            threadRetentionItemMetricAttributes("skipped", "policy_changed"),
          );
        continue;
      }
      if (gate !== null) return gate;
      const cleanupResult = yield* runRetentionEffectWithinDeadline({
        effect: input.retryRuntimeCleanup(item.threadId),
        deadlineAt,
        now: input.now,
        maxDurationMs: RETENTION_PREPARATION_TIMEOUT_MS,
      });
      if (Option.isNone(cleanupResult)) return "preparation_timeout" as const;
      if (cleanupResult.value === "active") {
        const skipped = yield* input.repository.transitionItem({
          runId: run.runId,
          threadId: item.threadId,
          expectedStatuses: ["selected"],
          nextStatus: "skipped",
          exclusionReason: "running",
          updatedAt: new Date(input.now()).toISOString(),
        });
        if (skipped)
          yield* increment(
            threadRetentionItemsTotal,
            threadRetentionItemMetricAttributes("skipped", "running"),
          );
        continue;
      }
      if (cleanupResult.value === "failed") return "provider_pressure" as const;
      const dispatched = yield* runRetentionEffectWithinDeadline({
        effect: input.orchestration.dispatch({
          type: "thread.retention-delete",
          commandId: CommandId.makeUnsafe(item.deletionCommandId),
          threadId: item.threadId,
          runId: run.runId,
          expectedLastActivityAt: item.expectedLastActivityAt,
          cutoffAt: run.cutoffAt,
          createdAt: new Date().toISOString(),
        }),
        deadlineAt,
        now: input.now,
        maxDurationMs: RETENTION_PREPARATION_TIMEOUT_MS,
      });
      if (Option.isNone(dispatched)) return "preparation_timeout" as const;
    }
    return null;
  });
}
