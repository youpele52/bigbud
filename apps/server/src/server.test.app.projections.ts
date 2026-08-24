import { Effect, Layer, Option } from "effect";

import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionCatalogQuery } from "./orchestration/Services/ProjectionCatalogQuery.ts";
import { SchedulerReactor } from "./orchestration/Services/SchedulerReactor.ts";
import { AutomationScheduleRepository } from "./persistence/Services/AutomationScheduleRepository.ts";
import { ProjectionThreadRepository } from "./persistence/Services/ProjectionThreads.ts";
import { makeDefaultOrchestrationReadModel, defaultProjectId } from "./server.test.fixtures.ts";
import type { BuildAppUnderTestOptions } from "./server.test.app.types.ts";

export function makeProjectionTestLayer(options?: BuildAppUnderTestOptions) {
  return Layer.mergeAll(
    Layer.mock(ProjectionCatalogQuery)({
      getStartupProjectCatalog: () =>
        Effect.succeed({ projectionSequence: 0, projects: [], remainingCount: 0 }),
      getProjectThreadSummaries: ({ projectId }) =>
        Effect.succeed({ projectionSequence: 0, projectId, threads: [] }),
      getSelectedThreadDetail: ({ threadId, messageCursor }) =>
        Effect.succeed({
          projectionSequence: 0,
          threadId,
          projectId: defaultProjectId,
          activityTurnId: null,
          messages: [],
          messageWindow: {
            order: "newest-first",
            requestedCursor: messageCursor ?? null,
            newestCursor: null,
            oldestCursor: null,
            nextCursor: null,
            hasOlder: false,
          },
          activities: [],
          activitiesTruncated: false,
          pendingApprovals: [],
          pendingApprovalsTruncated: false,
          pendingUserInputs: [],
          pendingUserInputsTruncated: false,
          activePlan: null,
          activeTasks: [],
          activeTasksTruncated: false,
          checkpoints: [],
          checkpointsTruncated: false,
        }),
      ...options?.layers?.projectionCatalogQuery,
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getSnapshot: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
      ...options?.layers?.projectionSnapshotQuery,
    }),
    Layer.mock(ProjectionThreadRepository)({
      getById: ({ threadId }) => {
        const thread = makeDefaultOrchestrationReadModel().threads.find(
          (candidate) => candidate.id === threadId,
        );
        return Effect.succeed(
          thread
            ? Option.some({
                threadId: thread.id,
                projectId: thread.projectId,
                title: thread.title,
                purpose: "standard",
                elevatorSummary: thread.elevatorSummary,
                elevatorSummaryMessageCount: thread.elevatorSummaryMessageCount,
                providerRuntimeExecutionTargetId: "local",
                workspaceExecutionTargetId: "local",
                executionTargetId: "local",
                modelSelection: thread.modelSelection,
                runtimeMode: thread.runtimeMode,
                interactionMode: thread.interactionMode,
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                latestTurnId: null,
                queuedPrompts: [],
                createdAt: thread.createdAt,
                updatedAt: thread.updatedAt,
                lastActivityAt: thread.updatedAt,
                archivedAt: thread.archivedAt,
                pinnedAt: thread.pinnedAt ?? null,
                deletingAt: null,
                deletedAt: thread.deletedAt,
              })
            : Option.none(),
        );
      },
      listByProjectId: () => Effect.succeed([]),
      upsert: () => Effect.void,
      deleteById: () => Effect.void,
      touchActivity: () => Effect.void,
      ...options?.layers?.projectionThreadRepository,
    }),
    Layer.mock(AutomationScheduleRepository)({
      create: () => Effect.die("not implemented"),
      getById: () => Effect.succeed(Option.none()),
      listByProject: () => Effect.succeed([]),
      listAll: () => Effect.succeed([]),
      claimDue: () => Effect.succeed([]),
      update: () => Effect.die("not implemented"),
      updateNextRun: () => Effect.void,
      pause: () => Effect.void,
      resume: () => Effect.void,
      complete: () => Effect.void,
      delete: () => Effect.succeed(false),
      recordRunStarted: () => Effect.void,
      recordRunDispatched: () => Effect.void,
      recordRunFinished: () => Effect.void,
      recordRunFailed: () => Effect.void,
      listRuns: () => Effect.succeed([]),
      claimOccurrence: () => Effect.succeed(Option.none()),
      getRunByOccurrence: () => Effect.succeed(Option.none()),
      getStartedRunByMessageId: () => Effect.succeed(Option.none()),
      listStartedRuns: () => Effect.succeed([]),
      releaseLease: () => Effect.void,
    }),
    Layer.mock(SchedulerReactor)({
      start: () => Effect.void,
      triggerNow: () => Effect.succeed({ status: "dispatched" as const }),
    }),
  );
}
