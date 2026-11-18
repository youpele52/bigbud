import { ProjectId, ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas";
import { BUILT_IN_CHATS_PROJECT_ID } from "@bigbud/contracts/constants/project.constant";
import type {
  GetStartupProjectCatalogResult,
  ProjectSummary,
  ThreadSummary,
} from "@bigbud/contracts/orchestration/orchestration.catalog";
import type { NativeApi } from "@bigbud/contracts/server/ipc.nativeApi.ts";
import { vi, type Mock } from "vitest";

import { useStore } from "../../../stores/main";
import { prepareComposerPrompt } from "./ChatView.sendTurn.prepare";
import type { UseOnSendInput } from "./ChatView.sendTurn.types";

export const chatsId = BUILT_IN_CHATS_PROJECT_ID;
export const otherProjectId = ProjectId.makeUnsafe("project-a");
export const recentId = ThreadId.makeUnsafe("synthetic-recent");
export const otherId = ThreadId.makeUnsafe("synthetic-restored");
const now = "2026-11-08T00:00:00.000Z";
const modelSelection = { provider: "codex", model: "gpt-5.5" } as const;

function summary(id: ThreadId, projectId: ProjectId): ThreadSummary {
  return {
    id,
    projectId,
    title: id,
    purpose: "standard",
    elevatorSummary: id,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "local",
    executionTargetId: "local",
    branch: null,
    worktreePath: null,
    createdAt: now,
    updatedAt: now,
    latestUserMessageAt: now,
    pinnedAt: null,
    sessionStatus: "stopped",
    providerName: "codex",
    activeTurnId: TurnId.makeUnsafe("completed-turn"),
    latestTurnState: "completed",
    isWatching: false,
    isWatched: false,
    isDelegated: false,
    isAwaitingApproval: false,
    isAwaitingUserInput: false,
  };
}

function project(id: ProjectId, index: number): ProjectSummary {
  return {
    id,
    title: id,
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "local",
    executionTargetId: "local",
    workspaceRoot: id === chatsId ? null : `/tmp/${id}`,
    lastUsedAt: `2026-11-0${7 - index}T00:00:00.000Z`,
    updatedAt: now,
    deletingAt: null,
    threadCount: 1,
    exceptionalThreadCount: 0,
    hasExceptionalThreads: false,
  };
}

export const emptyPage: GetStartupProjectCatalogResult = {
  projectionSequence: 10,
  projects: [],
  remainingCount: 0,
};
export const chatsPage: GetStartupProjectCatalogResult = {
  ...emptyPage,
  projects: [project(chatsId, 2)],
};

export function createProjectGateApi() {
  const summaries = [summary(recentId, chatsId), summary(otherId, otherProjectId)];
  const projects = [otherProjectId, ProjectId.makeUnsafe("project-b"), chatsId].map(project);
  const orchestration = {
    getSidebarThreadCatalog: vi.fn(async () => ({
      projectionSequence: 10,
      threads: summaries,
      recentThreadIds: [recentId],
      pinnedThreadIds: [],
    })),
    getStartupProjectCatalog: vi.fn<NativeApi["orchestration"]["getStartupProjectCatalog"]>(
      async ({ scope, priorityProjectId, limit = 1 }) => {
        const ordered = priorityProjectId
          ? [
              ...projects.filter((entry) => entry.id === priorityProjectId),
              ...projects.filter((entry) => entry.id !== priorityProjectId),
            ]
          : projects;
        return {
          projectionSequence: 10,
          projects: scope === "local" ? ordered.slice(0, limit) : [],
          remainingCount: scope === "local" ? projects.length - limit : 0,
        };
      },
    ),
    getProjectThreadSummaries: vi.fn<NativeApi["orchestration"]["getProjectThreadSummaries"]>(
      async ({ projectId }) => ({
        projectionSequence: 10,
        projectId,
        threads: summaries.filter((thread) => thread.projectId === projectId),
      }),
    ),
    getSelectedThreadDetail: vi.fn<NativeApi["orchestration"]["getSelectedThreadDetail"]>(
      async ({ threadId }) => ({
        projectionSequence: 10,
        threadId,
        projectId: summaries.find((thread) => thread.id === threadId)!.projectId,
        activityTurnId: null,
        messages: [],
        messageWindow: {
          order: "newest-first",
          requestedCursor: null,
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
    ),
  };
  return { api: { orchestration } as unknown as NativeApi, orchestration };
}

export function resetProjectGateStore() {
  useStore.setState(useStore.getInitialState(), true);
}

export async function prepareRecentPrompt(
  api: NativeApi,
  prompt = "Synthetic follow-up",
): Promise<{
  result: Awaited<ReturnType<typeof prepareComposerPrompt>>;
  setThreadError: Mock<UseOnSendInput["setThreadError"]>;
  resetComposerDraft: Mock<() => void>;
  promptRef: { current: string };
}> {
  const setThreadError = vi.fn<UseOnSendInput["setThreadError"]>();
  const resetComposerDraft = vi.fn<() => void>();
  const promptRef = { current: prompt };
  const result = await prepareComposerPrompt({
    api,
    sendInput: {
      activeThread: useStore.getState().threads.find((thread) => thread.id === recentId),
      activeProject: useStore.getState().projects.find((entry) => entry.id === chatsId),
      promptRef,
      composerImages: [],
      composerFiles: [],
      composerAnnotations: [],
      composerTerminalContexts: [],
      selectedProvider: "codex",
      selectedModel: "gpt-5.5",
      selectedProviderModels: [],
      selectedPromptEffort: null,
      selectedModelSelection: modelSelection,
      setThreadError,
    } as unknown as UseOnSendInput,
    resetComposerDraft,
  });
  return { result, setThreadError, resetComposerDraft, promptRef };
}

export function deferredProjectPage() {
  let resolve!: (page: GetStartupProjectCatalogResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<GetStartupProjectCatalogResult>((resolvePage, rejectPage) => {
    resolve = resolvePage;
    reject = rejectPage;
  });
  return { promise, resolve, reject };
}
