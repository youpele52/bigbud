import { useMemo } from "react";
import type { ProjectId } from "@bigbud/contracts/core/baseSchemas";
import type { Project, SidebarThreadSummary } from "../../models/types";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { useSidebarGitStatus } from "../../hooks/useSidebarGitStatus";

export function useSidebarProjectGitStatus(
  projects: Project[],
  sidebarThreads: SidebarThreadSummary[],
  projectCwdById: ReadonlyMap<ProjectId, string | null>,
) {
  const projectExecutionTargetIdById = useMemo(
    () =>
      new Map(
        projects.map(
          (project) => [project.id, resolveWorkspaceExecutionTargetId(project)] as const,
        ),
      ),
    [projects],
  );

  const threadGitTargets = useMemo(
    () =>
      sidebarThreads.map((thread) => ({
        threadId: thread.id,
        branch: thread.branch,
        cwd: thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null,
        executionTargetId:
          thread.workspaceExecutionTargetId !== undefined || thread.executionTargetId !== undefined
            ? resolveWorkspaceExecutionTargetId(thread)
            : projectExecutionTargetIdById.get(thread.projectId),
      })),
    [projectCwdById, projectExecutionTargetIdById, sidebarThreads],
  );
  const prByThreadId = useSidebarGitStatus(threadGitTargets);

  return prByThreadId;
}
