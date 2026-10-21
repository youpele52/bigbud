import {
  BUILT_IN_CHATS_PROJECT_ID,
  BUILT_IN_CHATS_PROJECT_TITLE,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import type {
  GetStartupProjectCatalogResult,
  GetProjectThreadSummariesResult,
  GetSidebarThreadCatalogResult,
  ThreadSummary,
} from "@bigbud/contracts/orchestration/orchestration.catalog";
import type { GetSelectedThreadDetailResult } from "@bigbud/contracts/orchestration/orchestration.detail.ts";
import { OrchestrationGetSelectedThreadDetailError } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import * as Effect from "effect/Effect";
import type { NormalizedWsRpcRequestBody } from "../../../../../test/wsRpcHarness";
import {
  resolveProviderRuntimeExecutionTargetId,
  resolveWorkspaceExecutionTargetId,
} from "../../../../lib/providerExecutionTargets";

/** Server startup always creates Chats, even when the selected fixture only contains a project. */
export function withBuiltInChatsProject(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  if (snapshot.projects.some((project) => project.id === BUILT_IN_CHATS_PROJECT_ID))
    return snapshot;
  const createdAt = new Date(0).toISOString();
  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
      {
        id: BUILT_IN_CHATS_PROJECT_ID,
        title: BUILT_IN_CHATS_PROJECT_TITLE,
        workspaceRoot: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
        deletedAt: null,
        deletingAt: null,
      },
    ],
  };
}

function summarizeThread(thread: OrchestrationReadModel["threads"][number]): ThreadSummary {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    purpose: thread.purpose ?? "standard",
    elevatorSummary: thread.elevatorSummary,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    providerRuntimeExecutionTargetId: resolveProviderRuntimeExecutionTargetId(thread),
    workspaceExecutionTargetId: resolveWorkspaceExecutionTargetId(thread),
    executionTargetId: resolveWorkspaceExecutionTargetId(thread),
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    latestUserMessageAt:
      thread.messages.findLast((message) => message.role === "user")?.createdAt ?? null,
    pinnedAt: thread.pinnedAt ?? null,
    sessionStatus: thread.session?.status ?? null,
    providerName: thread.session?.providerName ?? null,
    activeTurnId: thread.session?.activeTurnId ?? thread.latestTurn?.turnId ?? null,
    retainedFamily: thread.session?.retainedFamily ?? false,
    latestTurnState: thread.latestTurn?.state ?? null,
    isWatching: (thread.watchingThreads?.length ?? 0) > 0,
    isWatched: false,
    isDelegated: false,
    isAwaitingApproval: false,
  };
}

/** Answer the same bounded reads used by production bootstrap, from the fake server's projection. */
export function resolveCatalogRpc(
  body: NormalizedWsRpcRequestBody,
  snapshot: OrchestrationReadModel,
): unknown {
  const projectionSequence = snapshot.snapshotSequence;
  const threads = snapshot.threads.filter((thread) => !thread.deletedAt && !thread.archivedAt);
  if (body._tag === ORCHESTRATION_WS_METHODS.getStartupProjectCatalog) {
    const projects = snapshot.projects.filter(
      (project) =>
        !project.deletedAt &&
        (resolveWorkspaceExecutionTargetId(project) === "local") === (body.scope === "local"),
    );
    const ordered = projects.toSorted(
      (a, b) => Number(b.id === body.priorityProjectId) - Number(a.id === body.priorityProjectId),
    );
    const limit = typeof body.limit === "number" ? body.limit : 1;
    return {
      projectionSequence,
      projects: ordered.slice(0, limit).map((project) => ({
        id: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        providerRuntimeExecutionTargetId: resolveProviderRuntimeExecutionTargetId(project),
        workspaceExecutionTargetId: resolveWorkspaceExecutionTargetId(project),
        executionTargetId: resolveWorkspaceExecutionTargetId(project),
        lastUsedAt: project.updatedAt,
        updatedAt: project.updatedAt,
        deletingAt: project.deletingAt,
        threadCount: threads.filter((thread) => thread.projectId === project.id).length,
        exceptionalThreadCount: 0,
        hasExceptionalThreads: false,
      })),
      remainingCount: Math.max(0, projects.length - limit),
    } satisfies GetStartupProjectCatalogResult;
  }
  if (body._tag === ORCHESTRATION_WS_METHODS.getSidebarThreadCatalog) {
    const recent = threads.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
    const pinned = threads.filter((thread) => thread.pinnedAt);
    const members = new Map([...recent, ...pinned].map((thread) => [thread.id, thread]));
    return {
      projectionSequence,
      threads: [...members.values()].map(summarizeThread),
      recentThreadIds: recent.map((thread) => thread.id),
      pinnedThreadIds: pinned.map((thread) => thread.id),
      projectThreadCounts: snapshot.projects.map((project) => ({
        projectId: project.id,
        threadCount: threads.filter((thread) => thread.projectId === project.id).length,
      })),
    } satisfies GetSidebarThreadCatalogResult;
  }
  if (body._tag === ORCHESTRATION_WS_METHODS.getProjectThreadSummaries) {
    const ordered = threads
      .filter((thread) => thread.projectId === body.projectId)
      .toSorted(
        (a, b) =>
          Number(b.id === body.priorityThreadId) - Number(a.id === body.priorityThreadId) ||
          b.updatedAt.localeCompare(a.updatedAt),
      );
    const limit = typeof body.limit === "number" ? body.limit : 5;
    const page = ordered.slice(0, limit);
    const last = page.at(-1);
    return {
      projectionSequence,
      projectId: body.projectId as GetProjectThreadSummariesResult["projectId"],
      threads: page.map(summarizeThread),
      ...(ordered.length > limit && last
        ? { nextCursor: { updatedAt: last.updatedAt, threadId: last.id } }
        : {}),
    } satisfies GetProjectThreadSummariesResult;
  }
  if (body._tag === ORCHESTRATION_WS_METHODS.getSelectedThreadDetail) {
    const thread = threads.find((thread) => thread.id === body.threadId);
    if (!thread)
      return Effect.fail(
        new OrchestrationGetSelectedThreadDetailError({
          message: "Thread is not present in the fake server projection.",
        }),
      );
    return {
      projectionSequence,
      threadId: thread.id,
      projectId: thread.projectId,
      activityTurnId: thread.latestTurn?.turnId ?? null,
      messages: thread.messages.map((message) => ({
        ...message,
        attachments: message.attachments ?? [],
        attachmentsTruncated: false,
      })),
      messageWindow: {
        order: "newest-first",
        requestedCursor: null,
        newestCursor: null,
        oldestCursor: null,
        nextCursor: null,
        hasOlder: false,
      },
      activities: thread.activities,
      activitiesTruncated: false,
      pendingApprovals: [],
      pendingApprovalsTruncated: false,
      pendingUserInputs: [],
      pendingUserInputsTruncated: false,
      activePlan: thread.proposedPlans.at(-1) ?? null,
      activeTasks: thread.tasks ?? [],
      activeTasksTruncated: false,
      checkpoints: thread.checkpoints,
      checkpointsTruncated: false,
    } satisfies GetSelectedThreadDetailResult;
  }
  if (body._tag === ORCHESTRATION_WS_METHODS.replayEvents)
    return {
      requestedFromSequenceExclusive: body.fromSequenceExclusive,
      retainedFromSequenceExclusive: 0,
      earliestAvailableSequence: 1,
      latestSequence: projectionSequence,
      availability: "available",
      complete: true,
      events: [],
    };
  if (
    body._tag === ORCHESTRATION_WS_METHODS.acknowledgeDelivery ||
    body._tag === ORCHESTRATION_WS_METHODS.acknowledgeDeliveryBaseline
  )
    return {
      accepted: true,
      fenced: false,
      acknowledgedSequence: body.appliedThroughSequence ?? body.appliedProjectionSequence,
    };
  return undefined;
}
