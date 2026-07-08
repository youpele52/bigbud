import {
  LOCAL_EXECUTION_TARGET_ID,
  ThreadId,
  type OrchestrationCheckpointSummary,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProject,
  type OrchestrationProposedPlan,
  type OrchestrationSession,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@bigbud/contracts";
import { Schema } from "effect";

import {
  ProjectionCheckpointDbRowSchema,
  ProjectionLatestTurnDbRowSchema,
  ProjectionProjectDbRowSchema,
  ProjectionStateDbRowSchema,
  ProjectionThreadActivityDbRowSchema,
  ProjectionThreadDbRowSchema,
  ProjectionThreadMessageDbRowSchema,
  ProjectionThreadProposedPlanDbRowSchema,
  ProjectionThreadSessionDbRowSchema,
  ProjectionThreadWatchDbRowSchema,
} from "./ProjectionSnapshotQuerySql.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";

type ProjectionProjectRow = Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>;
type ProjectionThreadRow = Schema.Schema.Type<typeof ProjectionThreadDbRowSchema>;
type ProjectionThreadMessageRow = Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>;
type ProjectionThreadProposedPlanRow = Schema.Schema.Type<
  typeof ProjectionThreadProposedPlanDbRowSchema
>;
type ProjectionThreadActivityRow = Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>;
type ProjectionThreadSessionRow = Schema.Schema.Type<typeof ProjectionThreadSessionDbRowSchema>;
type ProjectionCheckpointRow = Schema.Schema.Type<typeof ProjectionCheckpointDbRowSchema>;
type ProjectionLatestTurnRow = Schema.Schema.Type<typeof ProjectionLatestTurnDbRowSchema>;
type ProjectionStateRow = Schema.Schema.Type<typeof ProjectionStateDbRowSchema>;
type ProjectionThreadWatchRow = Schema.Schema.Type<typeof ProjectionThreadWatchDbRowSchema>;

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

export function computeSnapshotSequence(stateRows: ReadonlyArray<ProjectionStateRow>): number {
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

export function mapProjectRow(row: ProjectionProjectRow): OrchestrationProject {
  return {
    id: row.projectId,
    title: row.title,
    providerRuntimeExecutionTargetId:
      row.providerRuntimeExecutionTargetId ?? row.executionTargetId ?? LOCAL_EXECUTION_TARGET_ID,
    workspaceExecutionTargetId:
      row.workspaceExecutionTargetId ?? row.executionTargetId ?? LOCAL_EXECUTION_TARGET_ID,
    executionTargetId: row.executionTargetId ?? LOCAL_EXECUTION_TARGET_ID,
    workspaceRoot: row.workspaceRoot,
    defaultModelSelection: row.defaultModelSelection,
    scripts: row.scripts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletingAt: row.deletingAt,
    deletedAt: row.deletedAt,
  };
}

export function mapCheckpointRow(row: ProjectionCheckpointRow): OrchestrationCheckpointSummary {
  return {
    turnId: row.turnId,
    checkpointTurnCount: row.checkpointTurnCount,
    checkpointRef: row.checkpointRef,
    status: row.status,
    files: row.files,
    assistantMessageId: row.assistantMessageId,
    completedAt: row.completedAt,
  };
}

function mapLatestTurnRow(row: ProjectionLatestTurnRow): OrchestrationLatestTurn {
  return {
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
  };
}

function mapThreadRow(
  row: ProjectionThreadRow,
  groupedRows: {
    messagesByThread: Map<string, Array<OrchestrationMessage>>;
    proposedPlansByThread: Map<string, Array<OrchestrationProposedPlan>>;
    activitiesByThread: Map<string, Array<OrchestrationThreadActivity>>;
    checkpointsByThread: Map<string, Array<OrchestrationCheckpointSummary>>;
    sessionsByThread: Map<string, OrchestrationSession>;
    latestTurnByThread: Map<string, OrchestrationLatestTurn>;
    watchingThreadsByWatcher: Map<string, Array<{ threadId: ThreadId; title: string }>>;
  },
): OrchestrationThread {
  return {
    id: row.threadId,
    projectId: row.projectId,
    title: row.title,
    elevatorSummary: row.elevatorSummary,
    elevatorSummaryMessageCount: row.elevatorSummaryMessageCount,
    providerRuntimeExecutionTargetId:
      row.providerRuntimeExecutionTargetId ?? row.executionTargetId ?? LOCAL_EXECUTION_TARGET_ID,
    workspaceExecutionTargetId:
      row.workspaceExecutionTargetId ?? row.executionTargetId ?? LOCAL_EXECUTION_TARGET_ID,
    executionTargetId: row.executionTargetId ?? LOCAL_EXECUTION_TARGET_ID,
    modelSelection: row.modelSelection,
    runtimeMode: row.runtimeMode,
    interactionMode: row.interactionMode,
    branch: row.branch,
    worktreePath: row.worktreePath,
    latestTurn: groupedRows.latestTurnByThread.get(row.threadId) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    deletingAt: row.deletingAt,
    deletedAt: row.deletedAt,
    messages: groupedRows.messagesByThread.get(row.threadId) ?? [],
    proposedPlans: groupedRows.proposedPlansByThread.get(row.threadId) ?? [],
    activities: groupedRows.activitiesByThread.get(row.threadId) ?? [],
    checkpoints: groupedRows.checkpointsByThread.get(row.threadId) ?? [],
    session: groupedRows.sessionsByThread.get(row.threadId) ?? null,
    watchingThreads: groupedRows.watchingThreadsByWatcher.get(row.threadId) ?? [],
    ...(row.parentThread !== null ? { parentThread: row.parentThread } : {}),
  };
}

export function assembleSnapshotRows(rows: {
  projectRows: ReadonlyArray<ProjectionProjectRow>;
  threadRows: ReadonlyArray<ProjectionThreadRow>;
  messageRows: ReadonlyArray<ProjectionThreadMessageRow>;
  proposedPlanRows: ReadonlyArray<ProjectionThreadProposedPlanRow>;
  activityRows: ReadonlyArray<ProjectionThreadActivityRow>;
  sessionRows: ReadonlyArray<ProjectionThreadSessionRow>;
  checkpointRows: ReadonlyArray<ProjectionCheckpointRow>;
  latestTurnRows: ReadonlyArray<ProjectionLatestTurnRow>;
  stateRows: ReadonlyArray<ProjectionStateRow>;
  threadWatchRows: ReadonlyArray<ProjectionThreadWatchRow>;
}) {
  const messagesByThread = new Map<string, Array<OrchestrationMessage>>();
  const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
  const activitiesByThread = new Map<string, Array<OrchestrationThreadActivity>>();
  const checkpointsByThread = new Map<string, Array<OrchestrationCheckpointSummary>>();
  const sessionsByThread = new Map<string, OrchestrationSession>();
  const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();
  const watchingThreadsByWatcher = new Map<string, Array<{ threadId: ThreadId; title: string }>>();

  let updatedAt: string | null = null;

  for (const row of rows.projectRows) {
    updatedAt = maxIso(updatedAt, row.updatedAt);
  }
  for (const row of rows.threadRows) {
    updatedAt = maxIso(updatedAt, row.updatedAt);
  }
  for (const row of rows.stateRows) {
    updatedAt = maxIso(updatedAt, row.updatedAt);
  }

  for (const row of rows.messageRows) {
    updatedAt = maxIso(updatedAt, row.updatedAt);
    const threadMessages = messagesByThread.get(row.threadId) ?? [];
    threadMessages.push({
      id: row.messageId,
      role: row.role,
      text: row.text,
      ...(row.attachments !== null ? { attachments: row.attachments } : {}),
      ...(row.replyTo !== null ? { replyTo: row.replyTo } : {}),
      turnId: row.turnId,
      streaming: row.isStreaming === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    messagesByThread.set(row.threadId, threadMessages);
  }

  for (const row of rows.proposedPlanRows) {
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

  for (const row of rows.activityRows) {
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

  for (const row of rows.checkpointRows) {
    updatedAt = maxIso(updatedAt, row.completedAt);
    const threadCheckpoints = checkpointsByThread.get(row.threadId) ?? [];
    threadCheckpoints.push(mapCheckpointRow(row));
    checkpointsByThread.set(row.threadId, threadCheckpoints);
  }

  for (const row of rows.latestTurnRows) {
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
    latestTurnByThread.set(row.threadId, mapLatestTurnRow(row));
  }

  for (const row of rows.sessionRows) {
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

  for (const row of rows.threadWatchRows) {
    const existing = watchingThreadsByWatcher.get(row.watcherThreadId) ?? [];
    if (!existing.some((entry) => entry.threadId === row.watchedThreadId)) {
      existing.push({
        threadId: row.watchedThreadId,
        title: row.watchedThreadTitle,
      });
    }
    watchingThreadsByWatcher.set(row.watcherThreadId, existing);
  }

  return {
    snapshotSequence: computeSnapshotSequence(rows.stateRows),
    projects: rows.projectRows.map(mapProjectRow),
    threads: rows.threadRows.map((row) =>
      mapThreadRow(row, {
        messagesByThread,
        proposedPlansByThread,
        activitiesByThread,
        checkpointsByThread,
        sessionsByThread,
        latestTurnByThread,
        watchingThreadsByWatcher,
      }),
    ),
    updatedAt: updatedAt ?? new Date(0).toISOString(),
  };
}
