import type { ThreadId } from "@bigbud/contracts";
import { useCallback } from "react";

import { StatusBanner } from "../common/StatusBanner";
import BranchToolbarProjectMenu from "./BranchToolbarProjectMenu";

import { newCommandId } from "../../lib/utils";
import { dispatchCommandWithOutcomeRecovery } from "../../lib/orchestrationCommandRecovery";
import { readNativeApi } from "../../rpc/nativeApi";
import { useComposerDraftStore } from "../../stores/composer";
import { useStore } from "../../stores/main";
import { preservePendingEnvMode } from "../../lib/threadMaterialization.envMode";
import {
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { useWorktreeToolbar } from "./useWorktreeToolbar";
import { WorktreeToolbarPicker } from "./WorktreeToolbarPicker";
import { WorktreeToolbarDialog } from "./WorktreeToolbarDialog";
import { BranchToolbarLayout } from "./BranchToolbar.layout";
import { isThreadWorkspaceLocked } from "./BranchToolbar.workspace.logic";
import type { WorktreeBinding } from "@bigbud/contracts/workspace/worktreeBinding.ts";
import { persistWorktreeDraftSelection } from "./WorktreeDraftSelection";
import { WorktreeOperationsDialog } from "./WorktreeOperationsDialog";

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
  const draftThread = useComposerDraftStore((store) => store.getDraftThread(threadId));
  const pendingEnvMode = useComposerDraftStore(
    (store) => store.draftsByThreadId[threadId]?.pendingEnvMode,
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);

  const serverThread = threads.find((thread) => thread.id === threadId);
  const activeProjectId = serverThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const workspaceTargetId =
    serverThread?.workspaceExecutionTargetId ??
    activeProject?.workspaceExecutionTargetId ??
    activeProject?.executionTargetId;
  const activeThreadId = serverThread?.id ?? (draftThread ? threadId : undefined);
  const activeThreadBranch = serverThread?.branch ?? draftThread?.branch ?? null;
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const branchCwd = activeWorktreePath ?? activeProject?.cwd ?? null;
  const hasServerThread = serverThread !== undefined;
  const effectiveEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread: hasServerThread && (serverThread?.messages.length ?? 0) > 0,
    draftThreadEnvMode: draftThread?.envMode ?? pendingEnvMode,
  });
  const envModeLocked = envLocked || (serverThread !== undefined && activeWorktreePath !== null);
  const workspaceLocked = isThreadWorkspaceLocked(serverThread);

  const setThreadBranch = useCallback(
    async (
      branch: string | null,
      worktreePath: string | null,
      existingCheckout = false,
      binding?: WorktreeBinding,
    ) => {
      if (!activeThreadId) return;
      const api = readNativeApi();
      const latestThread = useStore
        .getState()
        .threads.find((thread) => thread.id === activeThreadId);
      if (
        latestThread &&
        (!hasServerThread ||
          isThreadWorkspaceLocked(latestThread) ||
          latestThread.worktreePath !== activeWorktreePath)
      )
        throw new Error(
          "Chat workspace or execution changed while this action was running. Refresh before switching.",
        );
      if (hasServerThread && !api) throw new Error("Server connection is unavailable.");
      const currentDraft = useComposerDraftStore.getState().getDraftThread(activeThreadId);
      if (!hasServerThread && (!currentDraft || currentDraft.worktreePath !== activeWorktreePath))
        throw new Error(
          "Draft workspace changed while this action was running. Select the worktree again.",
        );
      if (workspaceLocked) throw new Error("Stop the active session before changing workspace.");
      if (api && hasServerThread) {
        if (
          worktreePath !== activeWorktreePath &&
          (!workspaceTargetId || workspaceTargetId === "local")
        ) {
          if (!api.worktrees || !activeProject?.cwd)
            throw new Error("Safe workspace switching is unavailable.");
          const inventory = await api.worktrees.list({
            cwd: activeProject.cwd,
            ...(workspaceTargetId ? { executionTargetId: workspaceTargetId } : {}),
          });
          const destination = inventory.entries.find(
            (entry) => entry.path === (worktreePath ?? inventory.checkoutPath),
          );
          if (!destination?.identity) throw new Error("Worktree identity is unavailable.");
          if (binding && destination.identity !== binding.identity)
            throw new Error("Worktree identity changed while selecting it.");
          await api.worktrees.select({
            cwd: activeProject.cwd,
            threadId: activeThreadId,
            commandId: newCommandId(),
            expectedPath: activeWorktreePath,
            path: destination.path,
            expectedIdentity: destination.identity,
            ...(workspaceTargetId ? { executionTargetId: workspaceTargetId } : {}),
          });
        } else
          await dispatchCommandWithOutcomeRecovery(api, {
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId: activeThreadId,
            branch,
            worktreePath,
          });
      }
      if (hasServerThread) {
        if (serverThread?.messages.length === 0)
          preservePendingEnvMode(
            activeThreadId,
            existingCheckout
              ? worktreePath
                ? "worktree"
                : "local"
              : resolveDraftEnvModeAfterBranchChange({
                  nextWorktreePath: worktreePath,
                  currentWorktreePath: activeWorktreePath,
                  effectiveEnvMode,
                }),
          );
        return;
      }
      const nextDraftEnvMode = existingCheckout
        ? worktreePath
          ? "worktree"
          : "local"
        : resolveDraftEnvModeAfterBranchChange({
            nextWorktreePath: worktreePath,
            currentWorktreePath: activeWorktreePath,
            effectiveEnvMode,
          });
      const context = {
        branch,
        worktreePath,
        ...(worktreePath && binding ? { worktreeBinding: binding } : {}),
        envMode: nextDraftEnvMode,
      };
      if (existingCheckout && currentDraft) {
        const { worktreeBinding: _previousBinding, ...previous } = currentDraft;
        await persistWorktreeDraftSelection(threadId, currentDraft, { ...previous, ...context });
      } else setDraftThreadContext(threadId, context);
    },
    [
      activeThreadId,
      serverThread?.messages.length,
      activeWorktreePath,
      hasServerThread,
      setDraftThreadContext,
      threadId,
      effectiveEnvMode,
      workspaceLocked,
      activeProject?.cwd,
      workspaceTargetId,
    ],
  );

  const worktrees = useWorktreeToolbar({
    selectedPath: activeWorktreePath,
    cwd: activeProject?.cwd ?? null,
    ...(workspaceTargetId ? { executionTargetId: workspaceTargetId } : {}),
    disabled: workspaceLocked,
    onSelect: setThreadBranch,
  });

  if (!activeThreadId) return null;

  return (
    <BranchToolbarLayout>
      <div className="min-w-0 justify-self-start max-w-full">
        {activeProject && (
          <BranchToolbarProjectMenu activeProject={activeProject} activeThreadId={activeThreadId} />
        )}
      </div>
      <div className="flex min-w-0 justify-center">
        {worktrees.inventory.data && (
          <WorktreeToolbarPicker
            inventory={worktrees.inventory.data}
            {...(worktrees.inventory.error ? { error: String(worktrees.inventory.error) } : {})}
            selectedPath={
              worktrees.inventory.data?.selectedPath ??
              activeWorktreePath ??
              worktrees.inventory.data?.checkoutPath ??
              branchCwd
            }
            disabled={workspaceLocked || worktrees.pending}
            createDisabled={worktrees.pending}
            onRefresh={() => void worktrees.refresh()}
            onCreate={() => worktrees.setTarget({ kind: "create" })}
            onOperations={() => worktrees.setShowOperations(true)}
            onSelect={worktrees.selectFromMenu}
            onDelete={(entry) => worktrees.setTarget({ kind: "delete", entry })}
          />
        )}
      </div>
      <div className="min-w-0 justify-self-end max-w-full">
        {activeProject && isGitRepo ? (
          <BranchToolbarBranchSelector
            activeProjectCwd={activeProject.cwd}
            executionTargetId={workspaceTargetId}
            activeThreadBranch={activeThreadBranch}
            activeWorktreePath={activeWorktreePath}
            branchCwd={branchCwd}
            effectiveEnvMode={effectiveEnvMode}
            envLocked={envModeLocked}
            workspaceLocked={workspaceLocked}
            onCreateWorktreeRequest={() => worktrees.setTarget({ kind: "create" })}
            {...(!workspaceTargetId || workspaceTargetId === "local"
              ? { onWorktreeOperationsRequest: () => worktrees.setShowOperations(true) }
              : {})}
            onSetThreadBranch={setThreadBranch}
            onSelectExistingWorktree={worktrees.selectExistingWorktree}
            {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
            {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
          />
        ) : (
          <div />
        )}
      </div>
      {worktrees.target && (
        <WorktreeToolbarDialog
          key={`${worktrees.target.kind}:${worktrees.target.entry?.path ?? "new"}`}
          target={worktrees.target}
          baseBranch={activeThreadBranch ?? "HEAD"}
          onClose={() => worktrees.setTarget(null)}
          onSubmit={worktrees.submit}
        />
      )}
      {worktrees.inventory.data?.issues?.length ? (
        <StatusBanner
          dismissalKey={["worktree", threadId, workspaceTargetId, branchCwd, "inventory-issues"]}
          variant="warning"
          className="col-span-3"
          dismissLabel="Dismiss workspace inventory warnings"
          description={
            <ul>
              {worktrees.inventory.data.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          }
        />
      ) : null}
      {activeWorktreePath && worktrees.inventory.error && (
        <StatusBanner
          dismissalKey={[
            "worktree",
            threadId,
            workspaceTargetId,
            activeWorktreePath,
            "inspection-error",
          ]}
          variant="error"
          className="col-span-3"
          dismissLabel="Dismiss workspace inspection error"
          description={
            <>
              Could not inspect the saved workspace. Its path may be missing or unsupported; history
              was not changed. {String(worktrees.inventory.error)}
            </>
          }
        />
      )}
      {worktrees.showOperations && (
        <WorktreeOperationsDialog
          operations={worktrees.operations.data}
          error={worktrees.operations.error}
          onClose={() => worktrees.setShowOperations(false)}
          onRecheck={worktrees.recheckOperation}
        />
      )}
    </BranchToolbarLayout>
  );
}
