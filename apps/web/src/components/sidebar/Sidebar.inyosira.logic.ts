import type { ThreadId } from "@bigbud/contracts";
import { isBuiltInChatsProject } from "@bigbud/contracts/constants/project.constant.ts";
import {
  THREAD_ORGANIZATION_STATES,
  type ThreadOrganizationState,
} from "@bigbud/contracts/orchestration/orchestration.organization.ts";

import { SIDEBAR_THREAD_PREVIEW_LIMIT } from "../../constants/sidebar";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import type { Project, SidebarThreadSummary } from "../../models/types/app.types";
import {
  getRemoteWorkspaceTargetLabel,
  isRemoteExecutionTargetId,
} from "./Sidebar.remoteWorkspaces.logic";
import { sortThreadsForSidebar } from "./Sidebar.sort.logic";
import { getPreviewItemsIncludingActive } from "./Sidebar.logic";

export const INYOSIRA_STATE_LABELS: Record<ThreadOrganizationState, string> = {
  present: "Present",
  "needs-you": "Needs you",
  later: "Later",
  done: "Done",
};

/** Later and Done remain below the attention and active-work sections. */
export const INYOSIRA_BOTTOM_STATES: readonly ThreadOrganizationState[] = ["later", "done"];

export type InyosiraGroups = Record<ThreadOrganizationState, ThreadId[]>;

export function organizationStateOf(summary: Pick<SidebarThreadSummary, "organization">) {
  return summary.organization?.state ?? "present";
}

/**
 * Groups known active threads by state, newest displayed activity first (latest user message,
 * falling back to creation), with a stable id tie-breaker. Pins never override activity order.
 */
export function groupInyosiraThreadIds(
  summaries: Readonly<Record<string, SidebarThreadSummary>>,
): InyosiraGroups {
  const groups: Record<ThreadOrganizationState, SidebarThreadSummary[]> = {
    present: [],
    "needs-you": [],
    later: [],
    done: [],
  };
  for (const summary of Object.values(summaries)) {
    if (summary.archivedAt !== null || (summary.deletingAt ?? null) !== null) continue;
    groups[organizationStateOf(summary)].push(summary);
  }
  const result = {} as InyosiraGroups;
  for (const state of THREAD_ORGANIZATION_STATES) {
    result[state] = sortThreadsForSidebar(groups[state], "updated_at").map((summary) => summary.id);
  }
  return result;
}

/** Same compact preview as projects, keeping the active thread visible in its sorted position. */
export function previewInyosiraThreadIds(
  threadIds: readonly ThreadId[],
  showAll: boolean,
  activeThreadId?: ThreadId | null,
) {
  return getPreviewItemsIncludingActive({
    items: threadIds,
    activeId: activeThreadId,
    showAll,
    previewLimit: SIDEBAR_THREAD_PREVIEW_LIMIT,
    getId: (id) => id,
  });
}

/** Only mounted thread rows, in display order, for navigation and numbered jump shortcuts. */
export function visibleInyosiraThreadIds(
  groups: InyosiraGroups,
  collapsedStates: readonly ThreadOrganizationState[],
  expandedThreadLists: readonly ThreadOrganizationState[] = [],
  activeThreadId?: ThreadId | null,
): ThreadId[] {
  return THREAD_ORGANIZATION_STATES.filter((state) => !collapsedStates.includes(state)).flatMap(
    (state) =>
      previewInyosiraThreadIds(groups[state], expandedThreadLists.includes(state), activeThreadId)
        .visibleItems,
  );
}

export type InyosiraLocation =
  | { readonly kind: "chat"; readonly label: string }
  | { readonly kind: "local"; readonly label: string }
  | { readonly kind: "remote"; readonly label: string };

/** Where the thread's workspace lives: Chat, a local project, or a remote workspace. */
export function resolveInyosiraLocation(
  summary: Pick<
    SidebarThreadSummary,
    "projectId" | "workspaceExecutionTargetId" | "executionTargetId"
  >,
  project: Pick<Project, "name"> | undefined,
): InyosiraLocation {
  if (isBuiltInChatsProject(summary.projectId)) return { kind: "chat", label: "Chat" };
  const targetId = resolveWorkspaceExecutionTargetId(summary);
  if (isRemoteExecutionTargetId(targetId)) {
    return {
      kind: "remote",
      label: project?.name ?? getRemoteWorkspaceTargetLabel(targetId) ?? "Remote workspace",
    };
  }
  return { kind: "local", label: project?.name ?? "Project" };
}

/** Drag payload for moving threads between Inyosira groups; chat drops keep their own payload. */
export const BIGBUD_INYOSIRA_THREAD_DRAG_MIME = "application/x-bigbud-inyosira-thread";

export function readInyosiraDragThreadId(
  dataTransfer: Pick<DataTransfer, "getData">,
  knownThreadIds: ReadonlySet<string>,
): ThreadId | null {
  const threadId = dataTransfer.getData(BIGBUD_INYOSIRA_THREAD_DRAG_MIME);
  return threadId && knownThreadIds.has(threadId) ? (threadId as ThreadId) : null;
}
