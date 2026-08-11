import type { OrchestrationEvent, OrchestrationReadModel } from "@bigbud/contracts";
import { OrchestrationCheckpointSummary, OrchestrationSession } from "@bigbud/contracts";
import { Effect } from "effect";

import type { OrchestrationProjectorDecodeError } from "./Errors.ts";
import {
  ThreadActivityAppendedPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadRevertedPayload,
  ThreadSessionSetPayload,
  ThreadTurnDiffCompletedPayload,
} from "./Schemas.ts";
import {
  checkpointStatusToLatestTurnState,
  decodeForEvent,
  projectProjectCreated,
  projectProjectDeleted,
  projectProjectDeletionFailed,
  projectProjectDeletionRequested,
  projectProjectMetaUpdated,
  updateThread,
} from "./projectorHelpers.ts";
import {
  projectThreadArchived,
  projectThreadCreated,
  projectThreadDeletionFailed,
  projectThreadDeletionRequested,
  projectThreadDeleted,
  projectThreadInteractionModeSet,
  projectThreadMetaUpdated,
  projectThreadPinned,
  projectThreadRuntimeModeSet,
  projectThreadTurnStartFailed,
  projectThreadUnarchived,
  projectThreadUnpinned,
} from "./projectorThreadLifecycle.ts";
import {
  compareThreadActivities,
  retainThreadActivitiesAfterRevert,
  retainThreadMessagesAfterRevert,
  retainThreadProposedPlansAfterRevert,
} from "./projectorThreadState.ts";
import { projectThreadTaskEvent } from "./projectorTasks.ts";
import { projectThreadMessageSent } from "./projectorThreadMessages.ts";
import { projectThreadQueuedPromptEvent } from "./projectorThreadQueuedPrompts.ts";

const MAX_THREAD_MESSAGES = 2_000;
const MAX_THREAD_CHECKPOINTS = 500;

export function projectEvent(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  const nextBase: OrchestrationReadModel = {
    ...model,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "project.created":
      return projectProjectCreated(nextBase, event);

    case "project.meta-updated":
      return projectProjectMetaUpdated(nextBase, event);

    case "project.deletion-requested":
      return projectProjectDeletionRequested(nextBase, event);

    case "project.deletion-failed":
      return projectProjectDeletionFailed(nextBase, event);

    case "project.deleted":
      return projectProjectDeleted(nextBase, event);

    case "thread.created":
      return projectThreadCreated(nextBase, event);

    case "thread.deletion-requested":
      return projectThreadDeletionRequested(nextBase, event);

    case "thread.deletion-failed":
      return projectThreadDeletionFailed(nextBase, event);

    case "thread.deleted":
      return projectThreadDeleted(nextBase, event);

    case "thread.archived":
      return projectThreadArchived(nextBase, event);

    case "thread.unarchived":
      return projectThreadUnarchived(nextBase, event);

    case "thread.pinned":
      return projectThreadPinned(nextBase, event);

    case "thread.unpinned":
      return projectThreadUnpinned(nextBase, event);

    case "thread.meta-updated":
      return projectThreadMetaUpdated(nextBase, event);

    case "thread.runtime-mode-set":
      return projectThreadRuntimeModeSet(nextBase, event);

    case "thread.interaction-mode-set":
      return projectThreadInteractionModeSet(nextBase, event);

    case "thread.turn-start-failed":
      return projectThreadTurnStartFailed(nextBase, event);

    case "thread.prompt-queued":
    case "thread.queued-prompt-removed":
    case "thread.queued-prompts-flushed":
      return projectThreadQueuedPromptEvent(nextBase, event);

    case "thread.turn-interrupt-requested": {
      const thread = nextBase.threads.find((entry) => entry.id === event.payload.threadId);
      if (!thread || event.payload.pendingFlushIntent === undefined)
        return Effect.succeed(nextBase);
      return Effect.succeed({
        ...nextBase,
        threads: updateThread(nextBase.threads, thread.id, {
          pendingInterruptFlushIntent: event.payload.pendingFlushIntent,
          updatedAt: event.occurredAt,
        }),
      });
    }

    case "thread.message-sent":
      return projectThreadMessageSent(nextBase, event);

    case "thread.session-set":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadSessionSetPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const session: OrchestrationSession = yield* decodeForEvent(
          OrchestrationSession,
          payload.session,
          event.type,
          "session",
        );

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            session,
            latestTurn:
              session.status === "running" && session.activeTurnId !== null
                ? {
                    turnId: session.activeTurnId,
                    state: "running",
                    requestedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.requestedAt
                        : session.updatedAt,
                    startedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? (thread.latestTurn.startedAt ?? session.updatedAt)
                        : session.updatedAt,
                    completedAt: null,
                    assistantMessageId:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.assistantMessageId
                        : null,
                  }
                : thread.latestTurn,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.proposed-plan-upserted":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadProposedPlanUpsertedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== payload.proposedPlan.id),
          payload.proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-200);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            proposedPlans,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.turn-diff-completed":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadTurnDiffCompletedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const checkpoint = yield* decodeForEvent(
          OrchestrationCheckpointSummary,
          {
            turnId: payload.turnId,
            checkpointTurnCount: payload.checkpointTurnCount,
            checkpointRef: payload.checkpointRef,
            status: payload.status,
            files: payload.files,
            assistantMessageId: payload.assistantMessageId,
            completedAt: payload.completedAt,
          },
          event.type,
          "checkpoint",
        );

        // Do not let a placeholder (status "missing") overwrite a checkpoint
        // that has already been captured with a real git ref (status "ready").
        const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return nextBase;
        }

        const checkpoints = [
          ...thread.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
          .slice(-MAX_THREAD_CHECKPOINTS);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            checkpoints,
            latestTurn: {
              turnId: payload.turnId,
              state: checkpointStatusToLatestTurnState(payload.status),
              requestedAt:
                thread.latestTurn?.turnId === payload.turnId
                  ? thread.latestTurn.requestedAt
                  : payload.completedAt,
              startedAt:
                thread.latestTurn?.turnId === payload.turnId
                  ? (thread.latestTurn.startedAt ?? payload.completedAt)
                  : payload.completedAt,
              completedAt: payload.completedAt,
              assistantMessageId: payload.assistantMessageId,
            },
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.reverted":
      return decodeForEvent(ThreadRevertedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const checkpoints = thread.checkpoints
            .filter((entry) => entry.checkpointTurnCount <= payload.turnCount)
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
            .slice(-MAX_THREAD_CHECKPOINTS);
          const retainedTurnIds = new Set(checkpoints.map((checkpoint) => checkpoint.turnId));
          const messages = retainThreadMessagesAfterRevert(
            thread.messages,
            retainedTurnIds,
            payload.turnCount,
          ).slice(-MAX_THREAD_MESSAGES);
          const proposedPlans = retainThreadProposedPlansAfterRevert(
            thread.proposedPlans,
            retainedTurnIds,
          ).slice(-200);
          const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);

          const latestCheckpoint = checkpoints.at(-1) ?? null;
          const latestTurn =
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId,
                };

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              checkpoints,
              messages,
              proposedPlans,
              activities,
              latestTurn,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.activity-appended":
      return decodeForEvent(
        ThreadActivityAppendedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const activities = [
            ...thread.activities.filter((entry) => entry.id !== payload.activity.id),
            payload.activity,
          ]
            .toSorted(compareThreadActivities)
            .slice(-500);

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              activities,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.task-upserted":
    case "thread.task-removed":
      return projectThreadTaskEvent(nextBase, event);

    default:
      return Effect.succeed(nextBase);
  }
}
