import type { ThreadId } from "@bigbud/contracts";
import { isBuiltInChatsProject } from "@bigbud/contracts/constants/project.constant.ts";
import {
  THREAD_ORGANIZATION_STATES,
  type ThreadOrganizationState,
} from "@bigbud/contracts/orchestration/orchestration.organization.ts";

import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import type { Project, SidebarThreadSummary } from "../../models/types/app.types";
import {
  getRemoteWorkspaceTargetLabel,
  isRemoteExecutionTargetId,
} from "./Sidebar.remoteWorkspaces.logic";

export const ITUTU_STATE_LABELS: Record<ThreadOrganizationState, string> = {
  present: "Present",
  "needs-you": "Needs you",
  later: "Later",
  done: "Done",
};

/** Needs you, Later, and Done sit together at the bottom of the sidebar. */
export const ITUTU_BOTTOM_STATES: readonly ThreadOrganizationState[] = [
  "needs-you",
  "later",
  "done",
];

export type ItutuGroups = Record<ThreadOrganizationState, ThreadId[]>;

const recency = (summary: SidebarThreadSummary) => summary.updatedAt ?? summary.createdAt;

export function organizationStateOf(summary: Pick<SidebarThreadSummary, "organization">) {
  return summary.organization?.state ?? "present";
}

/**
 * Groups every known active thread by its organization state, newest activity first with a
 * stable id tie-breaker, matching the server's state pages.
 */
export function groupItutuThreadIds(
  summaries: Readonly<Record<string, SidebarThreadSummary>>,
): ItutuGroups {
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
  const result = {} as ItutuGroups;
  for (const state of THREAD_ORGANIZATION_STATES) {
    result[state] = groups[state]
      .toSorted(
        (left, right) =>
          recency(right).localeCompare(recency(left)) || left.id.localeCompare(right.id),
      )
      .map((summary) => summary.id);
  }
  return result;
}

/** Thread ids in display order, skipping collapsed groups, for keyboard navigation. */
export function visibleItutuThreadIds(
  groups: ItutuGroups,
  collapsedStates: readonly ThreadOrganizationState[],
): ThreadId[] {
  return THREAD_ORGANIZATION_STATES.filter((state) => !collapsedStates.includes(state)).flatMap(
    (state) => groups[state],
  );
}

export type ItutuLocation =
  | { readonly kind: "chat"; readonly label: string }
  | { readonly kind: "local"; readonly label: string }
  | { readonly kind: "remote"; readonly label: string };

/** Where the thread's workspace lives: Chat, a local project, or a remote workspace. */
export function resolveItutuLocation(
  summary: Pick<
    SidebarThreadSummary,
    "projectId" | "workspaceExecutionTargetId" | "executionTargetId"
  >,
  project: Pick<Project, "name"> | undefined,
): ItutuLocation {
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

/** Drag payload for moving threads between Ìtútù groups; chat drops keep their own payload. */
export const BIGBUD_ITUTU_THREAD_DRAG_MIME = "application/x-bigbud-itutu-thread";

export function readItutuDragThreadId(
  dataTransfer: Pick<DataTransfer, "getData">,
  knownThreadIds: ReadonlySet<string>,
): ThreadId | null {
  const threadId = dataTransfer.getData(BIGBUD_ITUTU_THREAD_DRAG_MIME);
  return threadId && knownThreadIds.has(threadId) ? (threadId as ThreadId) : null;
}
