import type { ProjectId, ThreadId } from "@bigbud/contracts";

import type { Project } from "~/models/types";
import { resolveWorkspaceExecutionTargetId } from "~/lib/providerExecutionTargets";
import { useDefaultChatCwd } from "~/rpc/serverState";
import { useComposerDraftStore, type DraftThreadState } from "~/stores/composer";
import { useProjectById, useThreadById } from "~/stores/main";
import { useUiStateStore } from "~/stores/ui";

interface WorkspaceThreadContext {
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}

interface ResolveWorkspaceContextInput {
  readonly serverThread: WorkspaceThreadContext | undefined;
  readonly draftThread: DraftThreadState | null;
  readonly selectedProjectId: ProjectId | null;
  readonly project: Project | undefined;
  readonly defaultChatCwd: string | null;
}

export function resolveWorkspaceContext(input: ResolveWorkspaceContextInput) {
  return {
    projectId:
      input.serverThread?.projectId ?? input.draftThread?.projectId ?? input.selectedProjectId,
    cwd:
      input.serverThread?.worktreePath ??
      input.draftThread?.worktreePath ??
      input.project?.cwd ??
      input.defaultChatCwd,
  };
}

export function useResolvedWorkspace(activeThreadId?: ThreadId | null) {
  const thread = useThreadById(activeThreadId ?? null);
  const draftThread = useComposerDraftStore((state) =>
    activeThreadId ? state.getDraftThread(activeThreadId) : null,
  );
  const selectedProjectId = useUiStateStore((state) => state.selectedProjectId);
  const projectId = thread?.projectId ?? draftThread?.projectId ?? selectedProjectId ?? null;
  const project = useProjectById(projectId);
  const defaultChatCwd = useDefaultChatCwd();
  const { cwd } = resolveWorkspaceContext({
    serverThread: thread,
    draftThread,
    selectedProjectId,
    project,
    defaultChatCwd,
  });
  const executionTargetId = thread
    ? resolveWorkspaceExecutionTargetId(thread)
    : project
      ? resolveWorkspaceExecutionTargetId(project)
      : undefined;

  return {
    thread,
    draftThread,
    project,
    cwd,
    executionTargetId,
  };
}
