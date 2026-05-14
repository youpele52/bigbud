import { derivePendingApprovals, type PendingApproval } from "../logic/session";
import type { Project, Thread } from "../models/types";

export interface PendingApprovalCoordinatorCandidate {
  threadId: Thread["id"];
  threadTitle: string;
  projectName?: string | undefined;
  workingDirectory?: string | undefined;
  approval: PendingApproval;
  pendingCount: number;
}

export function collectGlobalPendingApprovalCandidate(
  threads: ReadonlyArray<Thread>,
  projects: ReadonlyArray<Project>,
): PendingApprovalCoordinatorCandidate | null {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  let candidate: PendingApprovalCoordinatorCandidate | null = null;
  let pendingCount = 0;

  for (const thread of threads) {
    const pendingApprovals = derivePendingApprovals(thread.activities);
    pendingCount += pendingApprovals.length;

    const approval = pendingApprovals[0] ?? null;
    if (!approval) {
      continue;
    }

    if (
      candidate &&
      (approval.createdAt > candidate.approval.createdAt ||
        (approval.createdAt === candidate.approval.createdAt &&
          thread.id.localeCompare(candidate.threadId) >= 0))
    ) {
      continue;
    }

    const project = projectById.get(thread.projectId);
    candidate = {
      threadId: thread.id,
      threadTitle: thread.title,
      ...(project?.name ? { projectName: project.name } : {}),
      ...((thread.worktreePath ?? project?.cwd)
        ? { workingDirectory: thread.worktreePath ?? project?.cwd ?? undefined }
        : {}),
      approval,
      pendingCount,
    };
  }

  if (!candidate) {
    return null;
  }

  return {
    ...candidate,
    pendingCount,
  };
}
