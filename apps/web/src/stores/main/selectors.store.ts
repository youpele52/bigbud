import { type ProjectId, ThreadId } from "@bigbud/contracts";
import { type AppState } from "./main.store";
import { type Project, type SidebarThreadSummary, type Thread } from "../../models/types";
import { EMPTY_THREAD_IDS, updateThreadState } from "./helpers.store";

// ── Selectors ─────────────────────────────────────────────────────────

export const selectProjectById =
  (projectId: Project["id"] | null | undefined) =>
  (state: AppState): Project | undefined =>
    projectId ? state.projects.find((project) => project.id === projectId) : undefined;

export const selectThreadById =
  (threadId: ThreadId | null | undefined) =>
  (state: AppState): Thread | undefined =>
    threadId ? state.threads.find((thread) => thread.id === threadId) : undefined;

export const selectSidebarThreadSummaryById =
  (threadId: ThreadId | null | undefined) =>
  (state: AppState): SidebarThreadSummary | undefined =>
    threadId ? state.sidebarThreadsById[threadId] : undefined;

/** Returns true when the thread's agent session is actively running.
 * Uses the same signal as the chat view spinner: session.status === "running". */
export const selectIsThreadRunning =
  (threadId: ThreadId | null | undefined) =>
  (state: AppState): boolean => {
    if (!threadId) return false;
    const summary = state.sidebarThreadsById[threadId];
    return summary?.session?.status === "running" && summary.session.activeTurnId != null;
  };

export const selectThreadIdsByProjectId =
  (projectId: ProjectId | null | undefined) =>
  (state: AppState): ThreadId[] =>
    projectId ? (state.threadIdsByProjectId[projectId] ?? EMPTY_THREAD_IDS) : EMPTY_THREAD_IDS;

// ── Misc state setters ────────────────────────────────────────────────

export function setError(state: AppState, threadId: ThreadId, error: string | null): AppState {
  return updateThreadState(state, threadId, (t) => {
    if (t.error === error) return t;
    return { ...t, error };
  });
}

export function setThreadBranch(
  state: AppState,
  threadId: ThreadId,
  branch: string | null,
  worktreePath: string | null,
): AppState {
  return updateThreadState(state, threadId, (t) => {
    if (t.branch === branch && t.worktreePath === worktreePath) return t;
    const cwdChanged = t.worktreePath !== worktreePath;
    return {
      ...t,
      branch,
      worktreePath,
      ...(cwdChanged ? { session: null } : {}),
    };
  });
}
