import { isBuiltInChatsProject, type ProjectId, type ThreadId } from "@bigbud/contracts";
import { useMemo } from "react";

import {
  isSshExecutionTargetId,
  parseRemoteExecutionTarget,
} from "../components/sidebar/Sidebar.remoteWorkspaces.logic";
import { resolveWorkspaceExecutionTargetId } from "../lib/providerExecutionTargets";
import type { Project, Thread } from "../models/types";
import { useStore } from "../stores/main";

export interface ThreadRemoteTarget {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly executionTargetId: string;
  /** Host shown in "Reconnecting to <host>…". */
  readonly hostLabel: string;
  readonly projectName: string | undefined;
  /** Remote path to verify and to re-open terminals in. */
  readonly cwd?: string;
  readonly worktreePath?: string;
}

type TargetThread = Pick<
  Thread,
  "id" | "projectId" | "worktreePath" | "workspaceExecutionTargetId" | "executionTargetId"
>;
type TargetProject = Pick<
  Project,
  "name" | "cwd" | "workspaceExecutionTargetId" | "executionTargetId"
>;

/**
 * The thread's SSH workspace target (same resolution as the thread route activation: the
 * project's target, else the thread's own), or `null` for local, built-in Chats and non-SSH.
 */
export function resolveThreadRemoteTarget(input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | undefined;
  readonly thread: TargetThread | undefined;
  readonly project: TargetProject | undefined;
}): ThreadRemoteTarget | null {
  const projectId = input.thread?.projectId ?? input.projectId;
  if (!projectId || isBuiltInChatsProject(projectId)) return null;
  const scope = input.project ?? input.thread;
  if (!scope) return null;
  const executionTargetId = resolveWorkspaceExecutionTargetId(scope);
  if (!isSshExecutionTargetId(executionTargetId)) return null;
  const worktreePath = input.thread?.worktreePath ?? undefined;
  const cwd = worktreePath ?? input.project?.cwd ?? undefined;
  return {
    threadId: input.threadId,
    projectId,
    executionTargetId,
    hostLabel: parseRemoteExecutionTarget(executionTargetId)?.host ?? executionTargetId,
    projectName: input.project?.name,
    ...(cwd ? { cwd } : {}),
    ...(worktreePath ? { worktreePath } : {}),
  };
}

export function useThreadRemoteTarget(
  threadId: ThreadId,
  projectId: ProjectId | undefined,
): ThreadRemoteTarget | null {
  const thread = useStore((state) => state.threads.find((entry) => entry.id === threadId));
  const resolvedProjectId = thread?.projectId ?? projectId;
  const project = useStore((state) =>
    resolvedProjectId ? state.projects.find((entry) => entry.id === resolvedProjectId) : undefined,
  );
  return useMemo(
    () => resolveThreadRemoteTarget({ threadId, projectId, thread, project }),
    [threadId, projectId, thread, project],
  );
}
