import { type OrchestrationEvent, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { ProjectionThreadWatchRepositoryShape } from "../../persistence/Services/ProjectionThreadWatches.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import {
  dispatchThreadWatchTriggerTurn,
  groupActiveWatchesByTriggerKey,
  isThreadWorkflowComplete,
  isWatcherThreadBusy,
} from "../ThreadWatch.logic.ts";
import { resolveThreadWorkflowStatus } from "../ThreadWorkflowStatus.logic.ts";

export function isThreadWatchRelevantEvent(
  event: OrchestrationEvent,
): event is Extract<
  OrchestrationEvent,
  { readonly type: "thread.session-set" | "thread.message-sent" | "thread.activity-appended" }
> {
  return (
    event.type === "thread.session-set" ||
    event.type === "thread.message-sent" ||
    event.type === "thread.activity-appended"
  );
}

export const maybeTriggerThreadWatchesForThread = Effect.fn("maybeTriggerThreadWatchesForThread")(
  function* (input: {
    readonly repository: ProjectionThreadWatchRepositoryShape;
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly watchedThreadId: ThreadId;
    readonly occurredAt: string;
  }) {
    const readModel = yield* input.orchestrationEngine.getReadModel();
    const watchedThread = readModel.threads.find((thread) => thread.id === input.watchedThreadId);
    if (!watchedThread || !isThreadWorkflowComplete(watchedThread)) {
      return;
    }

    const activeWatches = yield* input.repository.listActiveByWatchedThread({
      watchedThreadId: input.watchedThreadId,
    });
    if (activeWatches.length === 0) {
      return;
    }

    const groups = groupActiveWatchesByTriggerKey(activeWatches);
    for (const [, group] of groups) {
      const first = group[0];
      if (!first) {
        continue;
      }

      const groupWatches = yield* input.repository.listActiveByWatcherAndMessage({
        watcherThreadId: first.watcherThreadId,
        sourceMessageId: first.sourceMessageId,
      });
      if (groupWatches.length === 0) {
        continue;
      }

      const completedThreads = [];
      let allComplete = true;
      for (const watch of groupWatches) {
        const thread = readModel.threads.find((entry) => entry.id === watch.watchedThreadId);
        if (!thread || !isThreadWorkflowComplete(thread)) {
          allComplete = false;
          break;
        }
        completedThreads.push({
          title: watch.watchedThreadTitle,
          threadId: watch.watchedThreadId,
          status: resolveThreadWorkflowStatus(thread),
        });
      }
      if (!allComplete || completedThreads.length === 0) {
        continue;
      }

      const watcherThread = readModel.threads.find((thread) => thread.id === first.watcherThreadId);
      if (isWatcherThreadBusy(watcherThread)) {
        continue;
      }

      const claimed = yield* input.repository.markGroupTriggered({
        watcherThreadId: first.watcherThreadId,
        sourceMessageId: first.sourceMessageId,
        triggeredAt: input.occurredAt,
      });
      if (!claimed || !watcherThread) {
        continue;
      }

      yield* dispatchThreadWatchTriggerTurn({
        orchestrationEngine: input.orchestrationEngine,
        watcherThread,
        completedThreads,
        createdAt: input.occurredAt,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to dispatch thread watch trigger turn", {
            watcherThreadId: first.watcherThreadId,
            sourceMessageId: first.sourceMessageId,
            cause: cause.toString(),
          }),
        ),
      );
    }
  },
);

export const handleThreadWatchDomainEvent = Effect.fn("handleThreadWatchDomainEvent")(
  function* (input: {
    readonly repository: ProjectionThreadWatchRepositoryShape;
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly event: OrchestrationEvent;
  }) {
    if (input.event.type === "thread.deleted" || input.event.type === "thread.deletion-requested") {
      yield* input.repository.cancelActiveForWatcher({
        watcherThreadId: input.event.payload.threadId,
        cancelledAt: input.event.occurredAt,
      });
      return;
    }

    if (!isThreadWatchRelevantEvent(input.event)) {
      return;
    }

    if (
      input.event.type === "thread.message-sent" &&
      (input.event.payload.role !== "assistant" || input.event.payload.streaming)
    ) {
      return;
    }

    yield* maybeTriggerThreadWatchesForThread({
      repository: input.repository,
      orchestrationEngine: input.orchestrationEngine,
      watchedThreadId: input.event.payload.threadId,
      occurredAt: input.event.occurredAt,
    });
  },
);
