import type { FiniteThreadRetentionPolicy } from "@bigbud/contracts/core/settings.threadRetention.ts";
import type { ServerThreadRetentionResult } from "@bigbud/contracts/server/threadRetention.ts";
import { Duration, Effect, Ref } from "effect";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { OrchestrationDispatchError } from "../../orchestration/Errors.ts";
import { resolveThreadSubtree } from "../../deletion/Services/ThreadDeletion.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import {
  THREAD_RETENTION_NONTERMINAL_RUN_STATUSES,
  type ThreadRetentionRepositoryShape,
} from "../../persistence/Services/ThreadRetentionRepository.ts";
import { serverCommandId } from "../../orchestration/Layers/ProviderCommandReactorHelpers.ts";
import { waitForReadModelCondition } from "../../orchestration/Layers/readModelSettle.ts";
import { cutoffForRetentionPolicy } from "./ThreadRetention.logic.ts";

const SELECTION_PAGE_SIZE = 250;
const DELETE_SETTLE_TIMEOUT_MS = 120_000;

function settleRetentionDelete(input: {
  readonly threadId: import("@bigbud/contracts").ThreadId;
  readonly orchestration: OrchestrationEngineShape;
  readonly timeoutMs: number;
}) {
  return Effect.gen(function* () {
    const seenPending = yield* Ref.make(false);
    return yield* waitForReadModelCondition({
      check: input.orchestration.getReadModel().pipe(
        Effect.flatMap((model) =>
          Effect.gen(function* () {
            const thread = model.threads.find((candidate) => candidate.id === input.threadId);
            if (!thread || thread.deletedAt !== null) {
              return { done: true as const, value: "deleted" as const };
            }
            if (thread.deletingAt !== null) {
              yield* Ref.set(seenPending, true);
              return { done: false as const };
            }
            if (yield* Ref.get(seenPending)) {
              return { done: true as const, value: "skipped" as const };
            }
            return { done: false as const };
          }),
        ),
      ),
      events: input.orchestration.streamDomainEvents,
      timeout: Duration.millis(input.timeoutMs),
      onTimeout: "pending" as const,
    });
  });
}

export function runDirectThreadRetention(input: {
  readonly policy: FiniteThreadRetentionPolicy;
  readonly trigger: "manual" | "scheduled";
  readonly repository: Pick<
    ThreadRetentionRepositoryShape,
    "selectNextPage" | "createOrGetActiveRun" | "insertSelectedItems" | "transitionRun"
  >;
  readonly orchestration: OrchestrationEngineShape;
  readonly cutoffAt?: string;
  readonly now?: () => number;
  readonly settleTimeoutMs?: number;
}): Effect.Effect<
  ServerThreadRetentionResult,
  ProjectionRepositoryError | OrchestrationDispatchError
> {
  return Effect.gen(function* () {
    const now = input.now ?? Date.now;
    const startedAt = now();
    const cutoffAt = input.cutoffAt ?? cutoffForRetentionPolicy(input.policy, startedAt);
    const createdAt = new Date(startedAt).toISOString();
    const settleTimeoutMs = input.settleTimeoutMs ?? DELETE_SETTLE_TIMEOUT_MS;
    const run = yield* input.repository.createOrGetActiveRun({
      runId: crypto.randomUUID(),
      trigger: input.trigger,
      policy: input.policy,
      cutoffAt,
      createdAt,
    });
    let cursor:
      | { readonly lastActivityAt: string; readonly threadId: import("@bigbud/contracts").ThreadId }
      | undefined;
    let eligibleCount = 0;
    let deletedCount = 0;
    let skippedCount = 0;
    let pendingCount = 0;

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
        const commandId = serverCommandId("thread-retention-delete");
        yield* input.repository.insertSelectedItems({
          runId: run.runId,
          candidates: [
            {
              threadId: candidate.threadId,
              lastActivityAt: candidate.lastActivityAt,
              deletionCommandId: commandId,
            },
          ],
          createdAt,
        });
        yield* input.orchestration.dispatch({
          type: "thread.retention-delete",
          commandId,
          threadId: candidate.threadId,
          runId: run.runId,
          expectedLastActivityAt: candidate.lastActivityAt,
          cutoffAt,
          createdAt,
        });
        const settled = yield* settleRetentionDelete({
          threadId: candidate.threadId,
          orchestration: input.orchestration,
          timeoutMs: settleTimeoutMs,
        });
        if (settled === "deleted") deletedCount += Math.max(1, threadCount);
        else if (settled === "skipped") skippedCount += Math.max(1, threadCount);
        else pendingCount += Math.max(1, threadCount);
      }
    }

    const completedAt = new Date(now()).toISOString();
    yield* input.repository.transitionRun({
      runId: run.runId,
      expectedStatuses: THREAD_RETENTION_NONTERMINAL_RUN_STATUSES,
      nextStatus: skippedCount > 0 || pendingCount > 0 ? "completed_with_failures" : "completed",
      updatedAt: completedAt,
      eligibleCount,
    });

    return {
      trigger: input.trigger,
      policy: input.policy,
      cutoffAt,
      eligibleCount,
      deletedCount,
      skippedCount,
      pendingCount,
      completedAt,
    };
  });
}
