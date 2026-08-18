import type { FiniteThreadRetentionPolicy } from "@bigbud/contracts/core/settings.threadRetention.ts";
import type { ServerThreadRetentionResult } from "@bigbud/contracts/server/threadRetention.ts";
import { Duration, Effect } from "effect";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { OrchestrationDispatchError } from "../../orchestration/Errors.ts";
import { resolveThreadSubtree } from "../../deletion/Services/ThreadDeletion.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { ThreadRetentionRepositoryShape } from "../../persistence/Services/ThreadRetentionRepository.ts";
import { serverCommandId } from "../../orchestration/Layers/ProviderCommandReactorHelpers.ts";
import { cutoffForRetentionPolicy } from "./ThreadRetention.logic.ts";

const SELECTION_PAGE_SIZE = 250;
const DELETE_SETTLE_TIMEOUT_MS = 30_000;
const DELETE_SETTLE_POLL_INTERVAL = Duration.millis(25);

export function runDirectThreadRetention(input: {
  readonly policy: FiniteThreadRetentionPolicy;
  readonly trigger: "manual" | "scheduled";
  readonly repository: Pick<ThreadRetentionRepositoryShape, "selectNextPage">;
  readonly orchestration: OrchestrationEngineShape;
  readonly now?: () => number;
}): Effect.Effect<
  ServerThreadRetentionResult,
  ProjectionRepositoryError | OrchestrationDispatchError
> {
  return Effect.gen(function* () {
    const now = input.now ?? Date.now;
    const startedAt = now();
    const cutoffAt = cutoffForRetentionPolicy(input.policy, startedAt);
    let cursor:
      | { readonly lastActivityAt: string; readonly threadId: import("@bigbud/contracts").ThreadId }
      | undefined;
    let eligibleCount = 0;
    let deletedCount = 0;
    let skippedCount = 0;

    while (true) {
      const candidates = yield* input.repository.selectNextPage({
        cutoffAt,
        ...(cursor ? { cursor } : {}),
        limit: SELECTION_PAGE_SIZE,
      });
      if (candidates.length === 0) break;
      cursor = candidates.at(-1)!;
      eligibleCount += candidates.length;

      for (const candidate of candidates) {
        const threadCount = yield* input.orchestration
          .getReadModel()
          .pipe(
            Effect.map((model) => resolveThreadSubtree(candidate.threadId, model.threads).length),
          );
        yield* input.orchestration.dispatch({
          type: "thread.delete",
          commandId: serverCommandId("thread-retention-delete"),
          threadId: candidate.threadId,
        });
        const settled = yield* Effect.gen(function* () {
          const deadline = now() + DELETE_SETTLE_TIMEOUT_MS;
          while (now() < deadline) {
            const state = yield* input.orchestration
              .getReadModel()
              .pipe(
                Effect.map((model) =>
                  model.threads.find((thread) => thread.id === candidate.threadId),
                ),
              );
            if (!state) return "deleted" as const;
            if (state.deletingAt === null) return "skipped" as const;
            yield* Effect.sleep(DELETE_SETTLE_POLL_INTERVAL);
          }
          return "pending" as const;
        });
        if (settled === "deleted") deletedCount += Math.max(1, threadCount);
        else skippedCount += Math.max(1, threadCount);
      }
    }

    return {
      trigger: input.trigger,
      policy: input.policy,
      cutoffAt,
      eligibleCount,
      deletedCount,
      skippedCount,
      completedAt: new Date(now()).toISOString(),
    };
  });
}
