import type { GitStatusResult, ThreadId } from "@bigbud/contracts";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { focusContextualChatTarget } from "~/lib/chatFocus";
import {
  createGitMutationOperationId,
  gitFetchMutationOptions,
  gitMutationKeys,
  gitPullMutationOptions,
  gitStatusQueryOptions,
} from "~/lib/gitReactQuery";
import { useComposerDraftStore } from "~/stores/composer";
import { DefaultBranchDialog } from "~/components/git/GitActionsControl.defaultBranchDialog";
import { resolveDefaultBranchActionDialogCopy } from "~/components/git/GitActionsControl.logic";
import { useGitActionRunner } from "~/components/git/GitActionsControl.runner";
import { actionsForStatus, GitPanelSyncActionButtons } from "./GitPanelSyncControl.actions";
import { GitPanelSyncIssueDialog } from "./GitPanelSyncIssueDialog";
import {
  buildGitSyncPrompt,
  formatGitSyncSummary,
  gitSyncActionLabel,
  type GitSyncAction,
  type GitSyncIssue,
  type GitSyncPromptPreference,
} from "./GitPanelSyncPrompt";

interface GitPanelSyncControlProps {
  activeThreadId?: ThreadId | null | undefined;
  cwd: string;
  executionTargetId?: string | undefined;
  gitStatus: GitStatusResult | null;
  gitStatusError?: string | null;
}

interface SyncIssueState {
  action: GitSyncAction;
  issue: GitSyncIssue;
  error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

function issueForAction(
  action: GitSyncAction,
  status: GitStatusResult | null,
  statusError?: string | null,
): GitSyncIssue | null {
  if (statusError || !status) return "status_unavailable";
  if (action === "fetch") return status.hasOriginRemote ? null : "missing_remote";
  if (!status.branch) return "detached";
  if (status.hasWorkingTreeChanges) return action === "pull" ? "dirty_pull" : "dirty_push";
  if (status.aheadCount > 0 && status.behindCount > 0) return "diverged";
  if (action === "pull" && !status.hasUpstream) return "missing_upstream";
  if (action === "pull" && status.behindCount === 0) return "operation_failed";
  if (action === "push" && !status.hasUpstream) return "missing_upstream";
  if (action === "push" && status.aheadCount === 0) return "operation_failed";
  return null;
}

function appendPreparedPrompt(threadId: ThreadId, prompt: string) {
  useComposerDraftStore.getState().appendPrompt(threadId, prompt);
  window.requestAnimationFrame(() => focusContextualChatTarget());
  toastManager.add({ type: "success", title: "Prompt added to composer" });
}

export function GitPanelSyncControl({
  activeThreadId,
  cwd,
  executionTargetId,
  gitStatus,
  gitStatusError = null,
}: GitPanelSyncControlProps) {
  const queryClient = useQueryClient();
  const [issueState, setIssueState] = useState<SyncIssueState | null>(null);
  const [pendingDefaultBranchPush, setPendingDefaultBranchPush] = useState<string | null>(null);
  const [isActionLocked, setIsActionLocked] = useState(false);
  const activeActionRef = useRef<GitSyncAction | null>(null);
  const actionLockRef = useRef(false);
  const pullMutation = useMutation(gitPullMutationOptions({ cwd, executionTargetId, queryClient }));
  const fetchMutation = useMutation(
    gitFetchMutationOptions({ cwd, executionTargetId, queryClient }),
  );
  const isStackedActionRunning =
    useIsMutating({ mutationKey: gitMutationKeys.runStackedAction(cwd, executionTargetId) }) > 0;
  const isPullRunning =
    useIsMutating({ mutationKey: gitMutationKeys.pull(cwd, executionTargetId) }) > 0;
  const isFetchRunning =
    useIsMutating({ mutationKey: gitMutationKeys.fetch(cwd, executionTargetId) }) > 0;
  const isBusy =
    isStackedActionRunning ||
    isPullRunning ||
    isFetchRunning ||
    pullMutation.isPending ||
    fetchMutation.isPending;

  const openIssue = useCallback((action: GitSyncAction, issue: GitSyncIssue, error?: unknown) => {
    setIssueState({ action, issue, error: error ? errorMessage(error) : null });
  }, []);

  const { runGitActionWithToast, isRunning } = useGitActionRunner({
    gitCwd: cwd,
    executionTargetId,
    activeThreadId: activeThreadId ?? null,
    isDefaultBranch: gitStatus?.isDefaultBranch ?? false,
    gitStatusForActions: gitStatus,
    threadToastData: activeThreadId ? { threadId: activeThreadId } : undefined,
    callbacks: {
      onRequestDefaultBranchConfirmation: ({ action, branchName }) => {
        if (action === "push") setPendingDefaultBranchPush(branchName);
      },
      onActionError: (error) => {
        openIssue(activeActionRef.current ?? "push", "operation_failed", error);
      },
    },
  });
  const releaseActionLock = useCallback(() => {
    actionLockRef.current = false;
    setIsActionLocked(false);
  }, []);
  const workspaceMutationBusy = useCallback(
    () =>
      isRunning ||
      pullMutation.isPending ||
      fetchMutation.isPending ||
      queryClient.isMutating({
        mutationKey: gitMutationKeys.runStackedAction(cwd, executionTargetId),
      }) > 0 ||
      queryClient.isMutating({ mutationKey: gitMutationKeys.pull(cwd, executionTargetId) }) > 0 ||
      queryClient.isMutating({ mutationKey: gitMutationKeys.fetch(cwd, executionTargetId) }) > 0,
    [
      cwd,
      executionTargetId,
      fetchMutation.isPending,
      isRunning,
      pullMutation.isPending,
      queryClient,
    ],
  );
  const actionBusy = isActionLocked || isBusy || isRunning;

  const runPull = useCallback(() => {
    const promise = pullMutation.mutateAsync({ operationId: createGitMutationOperationId() });
    toastManager.promise(promise, {
      loading: {
        title: "Pulling...",
        data: activeThreadId ? { threadId: activeThreadId } : undefined,
      },
      success: (result) => ({
        title: result.status === "pulled" ? "Pulled" : "Already up to date",
        description:
          result.status === "pulled"
            ? `Updated ${result.branch} from ${result.upstreamBranch ?? "upstream"}`
            : `${result.branch} is already synchronized.`,
        data: activeThreadId ? { threadId: activeThreadId } : undefined,
      }),
      error: (error) => ({
        title: "Pull failed",
        description: errorMessage(error),
        data: activeThreadId ? { threadId: activeThreadId } : undefined,
      }),
    });
    void promise
      .catch((error) => openIssue("pull", "operation_failed", error))
      .finally(releaseActionLock);
  }, [activeThreadId, openIssue, pullMutation, releaseActionLock]);

  const runFetch = useCallback(() => {
    const promise = fetchMutation.mutateAsync({ operationId: createGitMutationOperationId() });
    toastManager.promise(promise, {
      loading: {
        title: "Fetching...",
        data: activeThreadId ? { threadId: activeThreadId } : undefined,
      },
      success: {
        title: "Fetched",
        description: "Remote refs are up to date.",
        data: activeThreadId ? { threadId: activeThreadId } : undefined,
      },
      error: (error) => ({
        title: "Fetch failed",
        description: errorMessage(error),
        data: activeThreadId ? { threadId: activeThreadId } : undefined,
      }),
    });
    void promise
      .catch((error) => openIssue("fetch", "operation_failed", error))
      .finally(releaseActionLock);
  }, [activeThreadId, fetchMutation, openIssue, releaseActionLock]);

  const runPush = useCallback(
    (
      options: {
        featureBranch?: boolean;
        skipDefaultBranchPrompt?: boolean;
        status?: GitStatusResult;
      } = {},
    ) => {
      if (!actionLockRef.current) {
        if (workspaceMutationBusy()) return;
        actionLockRef.current = true;
        setIsActionLocked(true);
      }
      setPendingDefaultBranchPush(null);
      void runGitActionWithToast({
        action: "push",
        ...(options.featureBranch !== undefined ? { featureBranch: options.featureBranch } : {}),
        ...(options.skipDefaultBranchPrompt !== undefined
          ? { skipDefaultBranchPrompt: options.skipDefaultBranchPrompt }
          : {}),
        ...(options.status !== undefined ? { statusOverride: options.status } : {}),
      }).finally(releaseActionLock);
    },
    [releaseActionLock, runGitActionWithToast, workspaceMutationBusy],
  );

  const confirmAndRun = useCallback(
    async (action: GitSyncAction) => {
      if (actionLockRef.current || actionBusy || workspaceMutationBusy()) return;
      actionLockRef.current = true;
      setIsActionLocked(true);
      activeActionRef.current = action;
      if (gitStatusError) {
        openIssue(action, "status_unavailable", gitStatusError);
        releaseActionLock();
        return;
      }
      let latestStatus: GitStatusResult;
      try {
        latestStatus = await queryClient.fetchQuery({
          ...gitStatusQueryOptions(cwd, executionTargetId),
          staleTime: 0,
        });
      } catch (error) {
        openIssue(action, "status_unavailable", error);
        releaseActionLock();
        return;
      }
      if (workspaceMutationBusy()) {
        openIssue(action, "operation_failed", "Another Git action is already in progress.");
        releaseActionLock();
        return;
      }
      const issue = issueForAction(action, latestStatus);
      if (issue) {
        openIssue(action, issue);
        releaseActionLock();
        return;
      }
      if (action === "pull") runPull();
      if (action === "fetch") runFetch();
      if (action === "push") runPush({ status: latestStatus });
    },
    [
      actionBusy,
      cwd,
      executionTargetId,
      gitStatusError,
      openIssue,
      queryClient,
      releaseActionLock,
      runFetch,
      runPull,
      runPush,
      workspaceMutationBusy,
    ],
  );

  const preparePrompt = useCallback(
    async (preference: GitSyncPromptPreference) => {
      if (!issueState || !activeThreadId) return;
      let latestStatus = gitStatus;
      try {
        latestStatus = await queryClient.fetchQuery({
          ...gitStatusQueryOptions(cwd, executionTargetId),
          staleTime: 0,
        });
      } catch (error) {
        const latestError = errorMessage(error);
        if (preference === "investigate") {
          const prompt = buildGitSyncPrompt({
            cwd,
            executionTargetId,
            status: null,
            action: issueState.action,
            issue: "status_unavailable",
            preference,
            error: latestError,
          });
          appendPreparedPrompt(activeThreadId, prompt);
          setIssueState(null);
          return;
        }
        setIssueState({
          action: issueState.action,
          issue: "status_unavailable",
          error: latestError,
        });
        return;
      }
      const refreshedIssue = issueForAction(issueState.action, latestStatus);
      const requiresReview =
        refreshedIssue !== issueState.issue &&
        (issueState.issue !== "operation_failed" || refreshedIssue !== null);
      if (requiresReview) {
        setIssueState({
          action: issueState.action,
          issue: refreshedIssue ?? "status_unavailable",
          error:
            refreshedIssue === null
              ? "Git status changed since this issue was opened. Review the current state before preparing instructions."
              : issueState.error,
        });
        return;
      }
      const prompt = buildGitSyncPrompt({
        cwd,
        executionTargetId,
        status: latestStatus,
        action: issueState.action,
        issue: issueState.issue,
        preference,
        error: issueState.error,
      });
      appendPreparedPrompt(activeThreadId, prompt);
      setIssueState(null);
    },
    [activeThreadId, cwd, executionTargetId, gitStatus, issueState, queryClient],
  );

  const syncSummary = gitStatusError
    ? "Remote status unavailable"
    : formatGitSyncSummary(gitStatus);
  const defaultBranchCopy = pendingDefaultBranchPush
    ? resolveDefaultBranchActionDialogCopy({
        action: "push",
        branchName: pendingDefaultBranchPush,
        includesCommit: false,
      })
    : null;
  const actions = actionsForStatus(gitStatus);

  return (
    <>
      <span className="text-[11px] text-muted-foreground/80" title={syncSummary}>
        {syncSummary}
      </span>
      <GitPanelSyncActionButtons
        actions={actions.map((action) => ({
          action,
          issue: issueForAction(action, gitStatus, gitStatusError),
          label:
            !gitStatus || gitStatusError
              ? "Investigate Git status"
              : gitSyncActionLabel(
                  action,
                  action === "pull" ? gitStatus.behindCount : gitStatus.aheadCount,
                ),
        }))}
        disabled={actionBusy}
        onAction={(action) => void confirmAndRun(action)}
      />
      {issueState ? (
        <GitPanelSyncIssueDialog
          open
          action={issueState.action}
          issue={issueState.issue}
          cwd={cwd}
          executionTargetId={executionTargetId}
          status={gitStatus}
          error={issueState.error}
          hasActiveThread={Boolean(activeThreadId)}
          onOpenChange={(open) => {
            if (!open) setIssueState(null);
          }}
          onPreparePrompt={(preference) => void preparePrompt(preference)}
        />
      ) : null}
      <DefaultBranchDialog
        open={pendingDefaultBranchPush !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDefaultBranchPush(null);
        }}
        copy={defaultBranchCopy}
        onAbort={() => setPendingDefaultBranchPush(null)}
        onContinueOnDefaultBranch={() => runPush({ skipDefaultBranchPrompt: true })}
        onCheckoutFeatureBranch={() =>
          runPush({ featureBranch: true, skipDefaultBranchPrompt: true })
        }
      />
    </>
  );
}
