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
import { sortThreadsForSidebar } from "./Sidebar.sort.logic";

export const INYOSIRA_STATE_LABELS: Record<ThreadOrganizationState, string> = {
  present: "Present",
  "needs-you": "Needs you",
  later: "Later",
  done: "Done",
};

/** Needs you, Later, and Done sit together at the bottom of the sidebar. */
export const INYOSIRA_BOTTOM_STATES: readonly ThreadOrganizationState[] = [
  "needs-you",
  "later",
  "done",
];

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

/** Thread ids in display order, skipping collapsed groups, for keyboard navigation. */
export function visibleInyosiraThreadIds(
  groups: InyosiraGroups,
  collapsedStates: readonly ThreadOrganizationState[],
): ThreadId[] {
  return THREAD_ORGANIZATION_STATES.filter((state) => !collapsedStates.includes(state)).flatMap(
    (state) => groups[state],
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
