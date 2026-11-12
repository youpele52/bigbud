import type {
  GetSelectedThreadDetailResult,
  ProjectSummary,
  ThreadSummary,
} from "@bigbud/contracts";
import { EventId } from "@bigbud/contracts";

import type { Project, SidebarThreadSummary, Thread } from "../../models/types";
import {
  isTranscriptHistoryActivity,
  retainUserInputHistoryActivities,
} from "./userInputHistory.store";
import {
  mapMessage,
  mapProposedPlan,
  mapTurnDiffSummary,
  toLegacyProvider,
  toLegacySessionStatus,
} from "./mappers.store";
import { hydrateDelegatedChildModelChoices } from "./events.store.delegations";
import { capProviderAgents } from "./events.store.providerAgents";
import { mergeNotificationTasks } from "../../notifications/taskCompletion.tasks";
import {
  buildLatestTurn,
  MAX_THREAD_ACTIVITIES,
  MAX_THREAD_CHECKPOINTS,
  MAX_THREAD_MESSAGES,
  MAX_THREAD_PROPOSED_PLANS,
} from "./helpers.store";

/** Keeps the first entry per id in one pass; the merge order decides which copy wins. */
function firstById<T extends { readonly id: string }>(entries: ReadonlyArray<T>): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    kept.push(entry);
  }
  return kept;
}

export function mapProjectSummary(project: ProjectSummary): Project {
  return {
    id: project.id,
    name: project.title,
    activeThreadCount: project.threadCount,
    providerRuntimeExecutionTargetId: project.providerRuntimeExecutionTargetId,
    workspaceExecutionTargetId: project.workspaceExecutionTargetId,
    executionTargetId: project.executionTargetId,
    cwd: project.workspaceRoot,
    workspaceKind: project.workspaceKind ?? "external",
    previousWorkspaceRoot: project.previousWorkspaceRoot ?? null,
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
    reason: summary.sessionReason ?? null,
    sessionEpoch: summary.sessionEpoch ?? 0,
    ...(summary.activeTurnId ? { activeTurnId: summary.activeTurnId } : {}),
    // Keeps the main composer's Stop for descendants that outlive the parent turn after reload.
    ...(summary.retainedFamily ? { retainedFamily: true } : {}),
    createdAt: summary.updatedAt,
    updatedAt: summary.updatedAt,
  };
}

function mapSummaryLatestTurn(summary: ThreadSummary): Thread["latestTurn"] {
  if (summary.latestTurn !== undefined) return summary.latestTurn;
  if (summary.latestTurnState === null || summary.activeTurnId === null) {
    return null;
  }
  return {
    turnId: summary.activeTurnId,
    state: summary.latestTurnState,
    requestedAt: summary.updatedAt,
    // Every summarized turn has started (the summary has no exact start time). A null start would
    // make a completed turn look unsettled after a reload and hide e.g. the plan follow-up actions.
    startedAt: summary.updatedAt,
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
    organization: summary.organization,
    deletingAt: null,
    updatedAt: summary.updatedAt,
    latestTurn: mapSummaryLatestTurn(summary),
    notificationSafety: summary.notificationSafety ?? {
      turnId: null,
      tasks: [],
      childThreadIds: [],
      pendingRequestIds: [],
      queuedPromptIds: [],
      overflow: true,
    },
    providerAgents: [...(summary.notificationSafety?.tasks ?? [])],
    recovery: summary.recovery ?? null,
    pendingTurnControlOperation: summary.pendingTurnControlOperation ?? null,
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
    organization: summary.organization,
    deletingAt: null,
    updatedAt: summary.updatedAt,
    latestTurn: thread.latestTurn,
    branch: summary.branch,
    worktreePath: summary.worktreePath,
    latestUserMessageAt: summary.latestUserMessageAt,
    hasPendingApprovals: summary.isAwaitingApproval,
    hasPendingUserInput: summary.isAwaitingUserInput ?? false,
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
  const messages = firstById(
    loadingOlder
      ? [...thread.messages, ...detailMessages]
      : [...detailMessages, ...thread.messages],
  )
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    )
    .slice(-MAX_THREAD_MESSAGES);
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
          state: thread.latestTurn?.state ?? "running",
          requestedAt: thread.latestTurn?.requestedAt ?? completedAssistantMessage.createdAt,
          startedAt: thread.latestTurn?.startedAt ?? completedAssistantMessage.createdAt,
          completedAt: thread.latestTurn?.completedAt ?? null,
          assistantMessageId: completedAssistantMessage.id,
          sourceProposedPlan: thread.pendingSourceProposedPlan,
        })
      : thread.latestTurn;
  const detailActivities = mergePendingActivities(detail).filter(
    (activity) => !loadingOlder || isTranscriptHistoryActivity(activity),
  );
  const activities = retainUserInputHistoryActivities(
    firstById([...thread.activities, ...detailActivities]).toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    ),
    MAX_THREAD_ACTIVITIES,
  );
  const detailPlans = detail.activePlan === null ? [] : [mapProposedPlan(detail.activePlan)];
  const proposedPlans = firstById([...thread.proposedPlans, ...detailPlans]).slice(
    -MAX_THREAD_PROPOSED_PLANS,
  );
  const detailCheckpoints = detail.checkpoints.map((checkpoint) =>
    mapTurnDiffSummary({ ...checkpoint, files: [] }),
  );
  const turnDiffSummaries = [...thread.turnDiffSummaries, ...detailCheckpoints]
    .filter(
      (checkpoint, index, all) =>
        all.findIndex((entry) => entry.turnId === checkpoint.turnId) === index,
    )
    .toSorted((left, right) => (left.checkpointTurnCount ?? 0) - (right.checkpointTurnCount ?? 0))
    .slice(-MAX_THREAD_CHECKPOINTS);
  return {
    ...thread,
    messages,
    latestTurn,
    activities,
    proposedPlans: loadingOlder ? thread.proposedPlans : proposedPlans,
    providerAgents: loadingOlder
      ? (thread.providerAgents ?? [])
      : capProviderAgents(
          mergeNotificationTasks(thread.providerAgents ?? [], detail.recentAgents ?? []).toSorted(
            (left, right) => left.createdAt.localeCompare(right.createdAt),
          ),
        ),
    delegatedChildren: loadingOlder
      ? (thread.delegatedChildren ?? [])
      : hydrateDelegatedChildModelChoices(
          detail.delegatedChildren ?? [],
          thread.delegatedChildren,
          activities,
        ),
    turnDiffSummaries: loadingOlder ? thread.turnDiffSummaries : turnDiffSummaries,
  };
}
