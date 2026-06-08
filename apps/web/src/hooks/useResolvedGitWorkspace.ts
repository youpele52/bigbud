import type { ThreadId } from "@bigbud/contracts";

import { resolveWorkspaceExecutionTargetId } from "~/lib/providerExecutionTargets";
import { useDefaultChatCwd } from "~/rpc/serverState";
import { useProjectById, useThreadById } from "~/stores/main";
import { useUiStateStore } from "~/stores/ui";

export function useResolvedGitWorkspace(activeThreadId?: ThreadId | null) {
  const thread = useThreadById(activeThreadId ?? null);
  const selectedProjectId = useUiStateStore((state) => state.selectedProjectId);
  const project = useProjectById(thread?.projectId ?? selectedProjectId ?? null);
  const defaultChatCwd = useDefaultChatCwd();
  const cwd = thread?.worktreePath ?? project?.cwd ?? defaultChatCwd ?? null;
  const executionTargetId = project ? resolveWorkspaceExecutionTargetId(project) : undefined;

  return {
    thread,
    project,
    cwd,
    executionTargetId,
  };
}
