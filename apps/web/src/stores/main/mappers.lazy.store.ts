import type {
  GetSelectedThreadDetailResult,
  ProjectSummary,
  ThreadSummary,
} from "@bigbud/contracts";
import { EventId } from "@bigbud/contracts";

import type { Project, SidebarThreadSummary, Thread } from "../../models/types";
import {
  mapMessage,
  mapProposedPlan,
  mapTurnDiffSummary,
  toLegacyProvider,
  toLegacySessionStatus,
} from "./mappers.store";
import { buildLatestTurn } from "./helpers.store";

export function mapProjectSummary(project: ProjectSummary): Project {
  return {
    id: project.id,
    name: project.title,
    activeThreadCount: project.threadCount,
    providerRuntimeExecutionTargetId: project.providerRuntimeExecutionTargetId,
    workspaceExecutionTargetId: project.workspaceExecutionTargetId,
    executionTargetId: project.executionTargetId,
    cwd: project.workspaceRoot,
    defaultModelSelection: null,
    updatedAt: project.updatedAt,
    deletingAt: project.deletingAt,
    scripts: [],
  };
}

function mapSummarySession(summary: ThreadSummary): Thread["session"] {
  if (summary.sessionStatus === null) {
    return null;
  }
  return {
    provider: toLegacyProvider(summary.providerName),
    status: toLegacySessionStatus(summary.sessionStatus),
    orchestrationStatus: summary.sessionStatus,
    ...(summary.activeTurnId ? { activeTurnId: summary.activeTurnId } : {}),
    createdAt: summary.updatedAt,
    updatedAt: summary.updatedAt,
  };
}

function mapSummaryLatestTurn(summary: ThreadSummary): Thread["latestTurn"] {
  if (summary.latestTurnState === null || summary.activeTurnId === null) {
    return null;
  }
  return {
    turnId: summary.activeTurnId,
    state: summary.latestTurnState,
    requestedAt: summary.updatedAt,
    startedAt: summary.latestTurnState === "running" ? summary.updatedAt : null,
    completedAt: summary.latestTurnState === "running" ? null : summary.updatedAt,
    assistantMessageId: null,
  };
}

export function mapThreadSummary(summary: ThreadSummary): Thread {
  return {
    id: summary.id,
    codexThreadId: null,
    projectId: summary.projectId,
    providerRuntimeExecutionTargetId: summary.providerRuntimeExecutionTargetId,
    workspaceExecutionTargetId: summary.workspaceExecutionTargetId,
    executionTargetId: summary.executionTargetId,
    title: summary.title,
    purpose: summary.purpose,
    elevatorSummary: summary.elevatorSummary,
    elevatorSummaryMessageCount: 0,
    modelSelection: summary.modelSelection,
    runtimeMode: summary.runtimeMode,
    interactionMode: summary.interactionMode,
    session: mapSummarySession(summary),
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: summary.createdAt,
    archivedAt: null,
    pinnedAt: summary.pinnedAt,
    deletingAt: null,
    updatedAt: summary.updatedAt,
    latestTurn: mapSummaryLatestTurn(summary),
    branch: summary.branch,
    worktreePath: summary.worktreePath,
    turnDiffSummaries: [],
    activities: [],
  };
}

export function mapSidebarThreadSummary(summary: ThreadSummary): SidebarThreadSummary {
  const thread = mapThreadSummary(summary);
  return {
    id: summary.id,
    projectId: summary.projectId,
    providerRuntimeExecutionTargetId: summary.providerRuntimeExecutionTargetId,
    workspaceExecutionTargetId: summary.workspaceExecutionTargetId,
    executionTargetId: summary.executionTargetId,
    title: summary.title,
    elevatorSummary: summary.elevatorSummary,
    elevatorSummaryMessageCount: 0,
    interactionMode: summary.interactionMode,
    session: thread.session,
    createdAt: summary.createdAt,
    archivedAt: null,
    pinnedAt: summary.pinnedAt,
    deletingAt: null,
    updatedAt: summary.updatedAt,
    latestTurn: thread.latestTurn,
    branch: summary.branch,
    worktreePath: summary.worktreePath,
    latestUserMessageAt: summary.latestUserMessageAt,
    hasPendingApprovals: summary.isAwaitingApproval,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function mergePendingActivities(detail: GetSelectedThreadDetailResult): Thread["activities"] {
  const activities = [...detail.activities];
  const requestIds = new Set(
    activities.flatMap((activity) => {
      const payload = activity.payload as { requestId?: unknown } | null;
      return payload && typeof payload.requestId === "string" ? [payload.requestId] : [];
    }),
  );
  for (const approval of detail.pendingApprovals) {
    if (!requestIds.has(approval.requestId)) {
      activities.push({
        id: EventId.makeUnsafe(`pending-approval-${approval.requestId}`),
        tone: "info",
        kind: "approval.requested",
        summary: "Approval requested",
        payload: { requestId: approval.requestId, requestKind: "tool" },
        turnId: approval.turnId,
        createdAt: approval.createdAt,
      });
    }
  }
  for (const request of detail.pendingUserInputs) {
    if (!requestIds.has(request.requestId)) {
      activities.push({
        id: EventId.makeUnsafe(`pending-user-input-${request.requestId}`),
        tone: "info",
        kind: "user-input.requested",
        summary: "User input requested",
        payload: { requestId: request.requestId, questions: request.questions },
        turnId: request.turnId,
        createdAt: request.createdAt,
      });
    }
  }
  return activities;
}

export function mergeThreadDetail(
  thread: Thread,
  detail: GetSelectedThreadDetailResult,
  loadingOlder: boolean,
): Thread {
  const detailMessages = detail.messages.map(mapMessage);
  const messages = (
    loadingOlder ? [...thread.messages, ...detailMessages] : [...detailMessages, ...thread.messages]
  )
    .filter((message, index, all) => all.findIndex((entry) => entry.id === message.id) === index)
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  const completedAssistantMessage = loadingOlder
    ? undefined
    : detailMessages.find(
        (message) =>
          message.role === "assistant" &&
          message.turnId === detail.activityTurnId &&
          !message.streaming,
      );
  const latestTurn =
    completedAssistantMessage?.turnId &&
    (thread.latestTurn === null || thread.latestTurn.turnId === completedAssistantMessage.turnId)
      ? buildLatestTurn({
          previous: thread.latestTurn,
          turnId: completedAssistantMessage.turnId,
          state:
            thread.latestTurn?.state === "interrupted" || thread.latestTurn?.state === "error"
              ? thread.latestTurn.state
              : "completed",
          requestedAt: thread.latestTurn?.requestedAt ?? completedAssistantMessage.createdAt,
          startedAt: thread.latestTurn?.startedAt ?? completedAssistantMessage.createdAt,
          completedAt: completedAssistantMessage.completedAt ?? completedAssistantMessage.createdAt,
          assistantMessageId: completedAssistantMessage.id,
          sourceProposedPlan: thread.pendingSourceProposedPlan,
        })
      : thread.latestTurn;
  const detailActivities = mergePendingActivities(detail);
  const activities = [...thread.activities, ...detailActivities]
    .filter((activity, index, all) => all.findIndex((entry) => entry.id === activity.id) === index)
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  const detailPlans = detail.activePlan === null ? [] : [mapProposedPlan(detail.activePlan)];
  const proposedPlans = [...thread.proposedPlans, ...detailPlans].filter(
    (plan, index, all) => all.findIndex((entry) => entry.id === plan.id) === index,
  );
  const detailCheckpoints = detail.checkpoints.map((checkpoint) =>
    mapTurnDiffSummary({ ...checkpoint, files: [] }),
  );
  const turnDiffSummaries = [...thread.turnDiffSummaries, ...detailCheckpoints]
    .filter(
      (checkpoint, index, all) =>
        all.findIndex((entry) => entry.turnId === checkpoint.turnId) === index,
    )
    .toSorted((left, right) => (left.checkpointTurnCount ?? 0) - (right.checkpointTurnCount ?? 0));
  return {
    ...thread,
    messages,
    latestTurn,
    activities: loadingOlder ? thread.activities : activities,
    proposedPlans: loadingOlder ? thread.proposedPlans : proposedPlans,
    turnDiffSummaries: loadingOlder ? thread.turnDiffSummaries : turnDiffSummaries,
  };
}
