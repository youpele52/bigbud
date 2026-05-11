/**
 * Assembles the OrchestrationReadModel from raw DB rows fetched by
 * ProjectionSnapshotQuerySql query builders.
 *
 * All row-to-domain mapping and cross-cutting assembly logic lives here.
 */
import {
  OrchestrationReadModel,
  type OrchestrationCheckpointSummary,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProject,
  type OrchestrationProposedPlan,
  type OrchestrationSession,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@bigbud/contracts";
import { Effect, Option, Schema } from "effect";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import {
  type ProjectionSnapshotQuerySql,
  ProjectionStateDbRowSchema,
} from "./ProjectionSnapshotQuerySql.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  type ProjectionSnapshotCounts,
  type ProjectionThreadCheckpointContext,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);

const REQUIRED_SNAPSHOT_PROJECTORS = [
  ORCHESTRATION_PROJECTOR_NAMES.projects,
  ORCHESTRATION_PROJECTOR_NAMES.threads,
  ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
  ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
  ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
  ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
  ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
] as const;

function maxIso(left: string | null, right: string): string {
  if (left === null) {
    return right;
  }
  return left > right ? left : right;
}

function computeSnapshotSequence(
  stateRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionStateDbRowSchema>>,
): number {
  if (stateRows.length === 0) {
    return 0;
  }
  const sequenceByProjector = new Map(
    stateRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
  );

  let minSequence = Number.POSITIVE_INFINITY;
  for (const projector of REQUIRED_SNAPSHOT_PROJECTORS) {
    const sequence = sequenceByProjector.get(projector);
    if (sequence === undefined) {
      return 0;
    }
    if (sequence < minSequence) {
      minSequence = sequence;
    }
  }

  return Number.isFinite(minSequence) ? minSequence : 0;
}

export function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

// ---------------------------------------------------------------------------
// Assembly functions
// ---------------------------------------------------------------------------

/**
 * Builds the OrchestrationReadModel from raw DB rows fetched by the query
 * builders.  Intended to be run inside a SQL transaction by the caller.
 */
export function assembleSnapshot(queries: ProjectionSnapshotQuerySql) {
  return Effect.gen(function* () {
    const [
      projectRows,
      threadRows,
      messageRows,
      proposedPlanRows,
      activityRows,
      sessionRows,
      checkpointRows,
      latestTurnRows,
      stateRows,
    ] = yield* Effect.all([
      queries
        .listProjectRows(undefined)
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getSnapshot:listProjects:query",
              "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeRows",
            ),
          ),
        ),
      queries
        .listThreadRows(undefined)
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getSnapshot:listThreads:query",
              "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeRows",
            ),
          ),
        ),
      queries
        .listThreadMessageRows(undefined)
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:query",
              "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:decodeRows",
            ),
          ),
        ),
      queries
        .listThreadProposedPlanRows(undefined)
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:query",
              "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:decodeRows",
            ),
          ),
        ),
      queries
        .listThreadActivityRows(undefined)
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:query",
              "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:decodeRows",
            ),
          ),
        ),
      queries
        .listThreadSessionRows(undefined)
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:query",
              "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:decodeRows",
            ),
          ),
        ),
      queries
        .listCheckpointRows(undefined)
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:query",
              "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:decodeRows",
            ),
          ),
        ),
      queries
        .listLatestTurnRows(undefined)
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:query",
              "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:decodeRows",
            ),
          ),
        ),
      queries
        .listProjectionStateRows(undefined)
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getSnapshot:listProjectionState:query",
              "ProjectionSnapshotQuery.getSnapshot:listProjectionState:decodeRows",
            ),
          ),
        ),
    ]);

    const messagesByThread = new Map<string, Array<OrchestrationMessage>>();
    const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
    const activitiesByThread = new Map<string, Array<OrchestrationThreadActivity>>();
    const checkpointsByThread = new Map<string, Array<OrchestrationCheckpointSummary>>();
    const sessionsByThread = new Map<string, OrchestrationSession>();
    const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();

    let updatedAt: string | null = null;

    for (const row of projectRows) {
      updatedAt = maxIso(updatedAt, row.updatedAt);
    }
    for (const row of threadRows) {
      updatedAt = maxIso(updatedAt, row.updatedAt);
    }
    for (const row of stateRows) {
      updatedAt = maxIso(updatedAt, row.updatedAt);
    }

    for (const row of messageRows) {
      updatedAt = maxIso(updatedAt, row.updatedAt);
      const threadMessages = messagesByThread.get(row.threadId) ?? [];
      threadMessages.push({
        id: row.messageId,
        role: row.role,
        text: row.text,
        ...(row.attachments !== null ? { attachments: row.attachments } : {}),
        turnId: row.turnId,
        streaming: row.isStreaming === 1,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
      messagesByThread.set(row.threadId, threadMessages);
    }

    for (const row of proposedPlanRows) {
      updatedAt = maxIso(updatedAt, row.updatedAt);
      const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
      threadProposedPlans.push({
        id: row.planId,
        turnId: row.turnId,
        planMarkdown: row.planMarkdown,
        implementedAt: row.implementedAt,
        implementationThreadId: row.implementationThreadId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
      proposedPlansByThread.set(row.threadId, threadProposedPlans);
    }

    for (const row of activityRows) {
      updatedAt = maxIso(updatedAt, row.createdAt);
      const threadActivities = activitiesByThread.get(row.threadId) ?? [];
      threadActivities.push({
        id: row.activityId,
        tone: row.tone,
        kind: row.kind,
        summary: row.summary,
        payload: row.payload,
        turnId: row.turnId,
        ...(row.sequence !== null ? { sequence: row.sequence } : {}),
        createdAt: row.createdAt,
      });
      activitiesByThread.set(row.threadId, threadActivities);
    }

    for (const row of checkpointRows) {
      updatedAt = maxIso(updatedAt, row.completedAt);
      const threadCheckpoints = checkpointsByThread.get(row.threadId) ?? [];
      threadCheckpoints.push({
        turnId: row.turnId,
        checkpointTurnCount: row.checkpointTurnCount,
        checkpointRef: row.checkpointRef,
        status: row.status,
        files: row.files,
        assistantMessageId: row.assistantMessageId,
        completedAt: row.completedAt,
      });
      checkpointsByThread.set(row.threadId, threadCheckpoints);
    }

    for (const row of latestTurnRows) {
      updatedAt = maxIso(updatedAt, row.requestedAt);
      if (row.startedAt !== null) {
        updatedAt = maxIso(updatedAt, row.startedAt);
      }
      if (row.completedAt !== null) {
        updatedAt = maxIso(updatedAt, row.completedAt);
      }
      if (latestTurnByThread.has(row.threadId)) {
        continue;
      }
      latestTurnByThread.set(row.threadId, {
        turnId: row.turnId,
        state:
          row.state === "error"
            ? "error"
            : row.state === "interrupted"
              ? "interrupted"
              : row.state === "completed"
                ? "completed"
                : "running",
        requestedAt: row.requestedAt,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        assistantMessageId: row.assistantMessageId,
        ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
          ? {
              sourceProposedPlan: {
                threadId: row.sourceProposedPlanThreadId,
                planId: row.sourceProposedPlanId,
              },
            }
          : {}),
      });
    }

    for (const row of sessionRows) {
      updatedAt = maxIso(updatedAt, row.updatedAt);
      sessionsByThread.set(row.threadId, {
        threadId: row.threadId,
        status: row.status,
        providerName: row.providerName,
        runtimeMode: row.runtimeMode,
        activeTurnId: row.activeTurnId,
        reason: row.reason,
        lastError: row.lastError,
        updatedAt: row.updatedAt,
      });
    }

    const projects: ReadonlyArray<OrchestrationProject> = projectRows.map((row) => ({
      id: row.projectId,
      title: row.title,
      workspaceRoot: row.workspaceRoot,
      defaultModelSelection: row.defaultModelSelection,
      scripts: row.scripts,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletingAt: row.deletingAt,
      deletedAt: row.deletedAt,
    }));

    const threads: ReadonlyArray<OrchestrationThread> = threadRows.map(
      (row) =>
        Object.assign(
          {
            id: row.threadId,
            projectId: row.projectId,
            title: row.title,
            modelSelection: row.modelSelection,
            runtimeMode: row.runtimeMode,
            interactionMode: row.interactionMode,
            branch: row.branch,
            worktreePath: row.worktreePath,
            latestTurn: latestTurnByThread.get(row.threadId) ?? null,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            archivedAt: row.archivedAt,
            deletingAt: row.deletingAt,
            deletedAt: row.deletedAt,
            messages: messagesByThread.get(row.threadId) ?? [],
            proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
            activities: activitiesByThread.get(row.threadId) ?? [],
            checkpoints: checkpointsByThread.get(row.threadId) ?? [],
            session: sessionsByThread.get(row.threadId) ?? null,
          },
          row.parentThread !== null ? { parentThread: row.parentThread } : undefined,
        ) satisfies OrchestrationThread,
    );

    const snapshot = {
      snapshotSequence: computeSnapshotSequence(stateRows),
      projects,
      threads,
      updatedAt: updatedAt ?? new Date(0).toISOString(),
    };

    return yield* decodeReadModel(snapshot).pipe(
      Effect.mapError(
        toPersistenceDecodeError("ProjectionSnapshotQuery.getSnapshot:decodeReadModel"),
      ),
    );
  });
}

/** Assembles getCounts. */
export function makeGetCounts(
  queries: ProjectionSnapshotQuerySql,
): ProjectionSnapshotQueryShape["getCounts"] {
  return () =>
    queries.readProjectionCounts(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getCounts:query",
          "ProjectionSnapshotQuery.getCounts:decodeRow",
        ),
      ),
      Effect.map(
        (row): ProjectionSnapshotCounts => ({
          projectCount: row.projectCount,
          threadCount: row.threadCount,
        }),
      ),
    );
}

/** Assembles getActiveProjectByWorkspaceRoot. */
export function makeGetActiveProjectByWorkspaceRoot(
  queries: ProjectionSnapshotQuerySql,
): ProjectionSnapshotQueryShape["getActiveProjectByWorkspaceRoot"] {
  return (workspaceRoot) =>
    queries.getActiveProjectRowByWorkspaceRoot({ workspaceRoot }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:query",
          "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeRow",
        ),
      ),
      Effect.map(
        Option.map(
          (row): OrchestrationProject => ({
            id: row.projectId,
            title: row.title,
            workspaceRoot: row.workspaceRoot,
            defaultModelSelection: row.defaultModelSelection,
            scripts: row.scripts,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            deletingAt: row.deletingAt,
            deletedAt: row.deletedAt,
          }),
        ),
      ),
    );
}

/** Assembles getFirstActiveThreadIdByProjectId. */
export function makeGetFirstActiveThreadIdByProjectId(
  queries: ProjectionSnapshotQuerySql,
): ProjectionSnapshotQueryShape["getFirstActiveThreadIdByProjectId"] {
  return (projectId) =>
    queries
      .getFirstActiveThreadIdByProject({ projectId })
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:query",
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:decodeRow",
          ),
        ),
        Effect.map(Option.map((row) => row.threadId)),
      );
}

/** Assembles getThreadCheckpointContext. */
export function makeGetThreadCheckpointContext(
  queries: ProjectionSnapshotQuerySql,
): ProjectionSnapshotQueryShape["getThreadCheckpointContext"] {
  return (threadId) =>
    Effect.gen(function* () {
      const threadRow = yield* queries
        .getThreadCheckpointContextThreadRow({ threadId })
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:query",
              "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:decodeRow",
            ),
          ),
        );
      if (Option.isNone(threadRow)) {
        return Option.none<ProjectionThreadCheckpointContext>();
      }

      const checkpointRows = yield* queries
        .listCheckpointRowsByThread({ threadId })
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:query",
              "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:decodeRows",
            ),
          ),
        );

      return Option.some({
        threadId: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        workspaceRoot: threadRow.value.workspaceRoot,
        worktreePath: threadRow.value.worktreePath,
        checkpoints: checkpointRows.map(
          (row): OrchestrationCheckpointSummary => ({
            turnId: row.turnId,
            checkpointTurnCount: row.checkpointTurnCount,
            checkpointRef: row.checkpointRef,
            status: row.status,
            files: row.files,
            assistantMessageId: row.assistantMessageId,
            completedAt: row.completedAt,
          }),
        ),
      });
    });
}
