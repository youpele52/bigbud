import { useCallback } from "react";

import { type ProjectId, type ThreadId } from "@bigbud/contracts";

import type { SidebarThreadSummary } from "../../models/types";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { isRemoteExecutionTargetId } from "./Sidebar.remoteWorkspaces.logic";

interface PendingRemoteThreadActivation {
  readonly threadId: ThreadId;
  readonly executionTargetId: string;
  readonly cwd?: string;
  readonly worktreePath?: string;
}

export interface SidebarRemoteThreadActivationInput {
  readonly sidebarThreadsById: Record<ThreadId, SidebarThreadSummary | undefined>;
  readonly projectCwdById: Map<ProjectId, string | null>;
  readonly navigateToThreadRoute: (threadId: ThreadId) => void;
}

export interface SidebarRemoteThreadActivationOutput {
  readonly navigateToThread: (threadId: ThreadId) => void | Promise<boolean>;
}

export function resolveRemoteThreadActivation(
  thread: SidebarThreadSummary | undefined,
  projectCwdById: Map<ProjectId, string | null>,
): PendingRemoteThreadActivation | null {
  if (!thread) {
    return null;
  }

  const executionTargetId = resolveWorkspaceExecutionTargetId(thread);
  if (!isRemoteExecutionTargetId(executionTargetId)) {
    return null;
  }

  const cwd = thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? undefined;
  return {
    threadId: thread.id,
    executionTargetId,
    ...(cwd ? { cwd } : {}),
    ...(thread.worktreePath ? { worktreePath: thread.worktreePath } : {}),
  };
}

/**
 * Thread clicks navigate directly: the route-level `ThreadRemoteTargetGate` owns reconnecting a
 * dead remote target for every entry point (sidebar, picker, palettes, links), so the sidebar no
 * longer runs its own pre-navigation access check.
 */
export function useSidebarRemoteThreadActivation({
  navigateToThreadRoute,
}: SidebarRemoteThreadActivationInput): SidebarRemoteThreadActivationOutput {
  const navigateToThread = useCallback(
    (threadId: ThreadId) => navigateToThreadRoute(threadId),
    [navigateToThreadRoute],
  );
  return { navigateToThread };
}
