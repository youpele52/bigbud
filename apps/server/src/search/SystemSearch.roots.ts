import { isBuiltInChatsProject } from "@bigbud/contracts/constants/project.constant";
import type { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { SystemSearchTier } from "@bigbud/contracts/search/systemSearch.ts";

import { isLocalExecutionTarget } from "../executionTargets.ts";

/** A project folder known to bigbud, newest first. */
export interface SearchProjectRoot {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly executionTargetId: string;
  readonly root: string;
}

/** A thread's own worktree folder (not itself a project folder). */
export interface SearchWorktreeRoot {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly executionTargetId: string;
  readonly root: string;
}

/** One root in an agent request; `rootId` is the opaque label echoed in hits. */
export interface SearchRootEntry {
  readonly rootId: string;
  readonly tier: SystemSearchTier;
  readonly executionTargetId: string;
  readonly root: string;
  readonly projectId?: ProjectId;
  readonly label: string;
}

export interface SearchRootPlan {
  /** T2: the current thread's worktree, else the current project folder. */
  readonly current: SearchRootEntry | null;
  /** T4 and T6 roots grouped by execution target; the local target comes first. */
  readonly others: ReadonlyArray<{
    readonly executionTargetId: string;
    readonly roots: ReadonlyArray<SearchRootEntry>;
  }>;
}

function folderLabel(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || root;
}

function key(target: string, root: string): string {
  return `${target}\u0000${root}`;
}

/** Remote folders are POSIX paths on the remote host. */
function isSameOrInside(child: string, parent: string): boolean {
  const base = parent.endsWith("/") ? parent : `${parent}/`;
  return child === parent || child.startsWith(base);
}

/**
 * Builds the root lists for one query (plan §4, Q3). T4 is every other project folder, local
 * first. T6 is remote folders bigbud registered for threads that are neither a project folder nor
 * inside one; nothing host-wide is ever searched. Duplicate folders are searched once.
 */
export function planSearchRoots(input: {
  readonly tiers: ReadonlyArray<SystemSearchTier>;
  readonly currentProjectId: ProjectId | null;
  readonly currentWorktree: SearchWorktreeRoot | null;
  readonly projects: ReadonlyArray<SearchProjectRoot>;
  readonly worktrees: ReadonlyArray<SearchWorktreeRoot>;
  readonly includeRemote: boolean;
}): SearchRootPlan {
  const projects = input.projects.filter((project) => !isBuiltInChatsProject(project.projectId));
  const currentProject = projects.find((project) => project.projectId === input.currentProjectId);
  const seen = new Set<string>();
  let nextId = 0;
  const entry = (
    tier: SystemSearchTier,
    value: { executionTargetId: string; root: string; projectId?: ProjectId; label: string },
  ): SearchRootEntry => ({ rootId: `r${nextId++}`, tier, ...value });

  let current: SearchRootEntry | null = null;
  const currentSource = input.currentWorktree ?? currentProject ?? null;
  if (currentSource && input.tiers.includes("currentProject")) {
    current = entry("currentProject", {
      executionTargetId: currentSource.executionTargetId,
      root: currentSource.root,
      projectId: currentSource.projectId,
      label: currentProject?.title ?? folderLabel(currentSource.root),
    });
  }
  if (currentSource) seen.add(key(currentSource.executionTargetId, currentSource.root));

  const groups = new Map<string, SearchRootEntry[]>();
  const add = (root: SearchRootEntry) => {
    const list = groups.get(root.executionTargetId) ?? [];
    list.push(root);
    groups.set(root.executionTargetId, list);
  };
  const allowed = (target: string) => isLocalExecutionTarget(target) || input.includeRemote;

  if (input.tiers.includes("otherProjectFiles")) {
    for (const project of projects) {
      const id = key(project.executionTargetId, project.root);
      if (project.projectId === input.currentProjectId || seen.has(id)) continue;
      if (!allowed(project.executionTargetId)) continue;
      seen.add(id);
      add(
        entry("otherProjectFiles", {
          executionTargetId: project.executionTargetId,
          root: project.root,
          projectId: project.projectId,
          label: project.title,
        }),
      );
    }
  }
  if (input.tiers.includes("remoteOutsideProjects") && input.includeRemote) {
    for (const worktree of input.worktrees) {
      if (isLocalExecutionTarget(worktree.executionTargetId)) continue;
      const id = key(worktree.executionTargetId, worktree.root);
      const insideProject = projects.some(
        (project) =>
          project.executionTargetId === worktree.executionTargetId &&
          isSameOrInside(worktree.root, project.root),
      );
      if (insideProject || seen.has(id)) continue;
      seen.add(id);
      add(
        entry("remoteOutsideProjects", {
          executionTargetId: worktree.executionTargetId,
          root: worktree.root,
          projectId: worktree.projectId,
          label: folderLabel(worktree.root),
        }),
      );
    }
  }
  const others = [...groups.entries()]
    .map(([executionTargetId, roots]) => ({ executionTargetId, roots }))
    .toSorted(
      (left, right) =>
        Number(!isLocalExecutionTarget(left.executionTargetId)) -
          Number(!isLocalExecutionTarget(right.executionTargetId)) ||
        left.executionTargetId.localeCompare(right.executionTargetId),
    );
  return { current, others };
}
