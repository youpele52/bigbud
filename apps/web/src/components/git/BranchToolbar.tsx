import type { ThreadId } from "@bigbud/contracts";
import { useCallback } from "react";
import { FolderPlusIcon } from "lucide-react";

import { newCommandId } from "../../lib/utils";
import { readNativeApi } from "../../rpc/nativeApi";
import { useComposerDraftStore } from "../../stores/composer";
import { useStore } from "../../stores/main";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSidebar } from "../ui/sidebar";
import {
  startSidebarAddProjectFlow,
  useSidebarAddProjectFlowVisible,
} from "../sidebar/SidebarAddProjectBridge";
import {
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";

interface BranchToolbarProps {
  threadId: ThreadId;
  envLocked: boolean;
  isGitRepo: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
}

export default function BranchToolbar({
  threadId,
  envLocked,
  isGitRepo,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
}: BranchToolbarProps) {
  const threads = useStore((store) => store.threads);
  const projects = useStore((store) => store.projects);
  const setThreadBranchAction = useStore((store) => store.setThreadBranch);
  const draftThread = useComposerDraftStore((store) => store.getDraftThread(threadId));
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);

  const serverThread = threads.find((thread) => thread.id === threadId);
  const activeProjectId = serverThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const activeThreadId = serverThread?.id ?? (draftThread ? threadId : undefined);
  const activeThreadBranch = serverThread?.branch ?? draftThread?.branch ?? null;
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const branchCwd = activeWorktreePath ?? activeProject?.cwd ?? null;
  const hasServerThread = serverThread !== undefined;
  const { setOpen } = useSidebar();
  const effectiveEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread,
    draftThreadEnvMode: draftThread?.envMode,
  });
  const envModeLocked = envLocked || (serverThread !== undefined && activeWorktreePath !== null);
  const addProjectFlowVisible = useSidebarAddProjectFlowVisible();

  const handleStartAddProject = useCallback(() => {
    void setOpen(true);
    startSidebarAddProjectFlow();
  }, [setOpen]);

  const setThreadBranch = useCallback(
    (branch: string | null, worktreePath: string | null) => {
      if (!activeThreadId) return;
      const api = readNativeApi();
      // If the effective cwd is about to change, stop the running session so the
      // next message creates a new one with the correct cwd.
      if (serverThread?.session && worktreePath !== activeWorktreePath && api) {
        void api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId: activeThreadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }
      if (api && hasServerThread) {
        void api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThreadId,
          branch,
          worktreePath,
        });
      }
      if (hasServerThread) {
        setThreadBranchAction(activeThreadId, branch, worktreePath);
        return;
      }
      const nextDraftEnvMode = resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: worktreePath,
        currentWorktreePath: activeWorktreePath,
        effectiveEnvMode,
      });
      setDraftThreadContext(threadId, {
        branch,
        worktreePath,
        envMode: nextDraftEnvMode,
      });
    },
    [
      activeThreadId,
      serverThread?.session,
      activeWorktreePath,
      hasServerThread,
      setThreadBranchAction,
      setDraftThreadContext,
      threadId,
      effectiveEnvMode,
    ],
  );

  if (!activeThreadId) return null;

  return (
    <div className="mx-auto flex w-full max-w-[calc(52rem+theme(spacing.6))] items-center justify-between px-3 pb-3 pt-1 sm:max-w-[calc(52rem+theme(spacing.10))] sm:px-5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={addProjectFlowVisible ? "Cancel new project" : "New project"}
              aria-pressed={addProjectFlowVisible}
              className="gap-1.5 text-muted-foreground/70 hover:text-foreground/80"
              onClick={handleStartAddProject}
            >
              <FolderPlusIcon className="size-3.5" />
              <span>New project</span>
            </Button>
          }
        />
        <TooltipPopup side="top">
          {addProjectFlowVisible ? "Cancel new project" : "New project"}
        </TooltipPopup>
      </Tooltip>

      {activeProject && isGitRepo ? (
        <BranchToolbarBranchSelector
          activeProjectCwd={activeProject.cwd}
          executionTargetId={activeProject.executionTargetId}
          activeThreadBranch={activeThreadBranch}
          activeWorktreePath={activeWorktreePath}
          branchCwd={branchCwd}
          effectiveEnvMode={effectiveEnvMode}
          envLocked={envModeLocked}
          onSetThreadBranch={setThreadBranch}
          {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
          {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
        />
      ) : (
        <div />
      )}
    </div>
  );
}
