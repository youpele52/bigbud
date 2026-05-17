import type { ThreadId } from "@bigbud/contracts";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import {
  buildMenuItems,
  type GitActionMenuItem,
  type DefaultBranchConfirmableAction,
  resolveDefaultBranchActionDialogCopy,
  resolveLiveThreadBranchUpdate,
  resolveQuickAction,
} from "./GitActionsControl.logic";
import { GitActionsControlActions } from "./GitActionsControl.actions";
import { CommitDialog } from "./GitActionsControl.commitDialog";
import { DefaultBranchDialog } from "./GitActionsControl.defaultBranchDialog";
import { useGitActionRunner } from "./GitActionsControl.runner";
import { toastManager } from "~/components/ui/toast";
import { openInPreferredEditor } from "../../models/editor";
import {
  gitInitMutationOptions,
  gitMutationKeys,
  gitPullMutationOptions,
  gitStatusQueryOptions,
} from "~/lib/gitReactQuery";
import { resolvePathLinkTarget } from "../../utils/terminal";
import { readNativeApi } from "../../rpc/nativeApi";
import { useComposerDraftStore } from "../../stores/composer";
import { useStore } from "../../stores/main";
import { useEffect } from "react";

interface GitActionsControlProps {
  gitCwd: string | null;
  executionTargetId?: string | undefined;
  activeThreadId: ThreadId | null;
}

interface PendingDefaultBranchAction {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  commitMessage?: string;
  onConfirmed?: () => void;
  filePaths?: string[];
}

export default function GitActionsControl({
  gitCwd,
  executionTargetId,
  activeThreadId,
}: GitActionsControlProps) {
  const threadToastData = useMemo(
    () => (activeThreadId ? { threadId: activeThreadId } : undefined),
    [activeThreadId],
  );
  const activeServerThread = useStore((store) =>
    activeThreadId ? store.threads.find((thread) => thread.id === activeThreadId) : undefined,
  );
  const activeDraftThread = useComposerDraftStore((store) =>
    activeThreadId ? store.getDraftThread(activeThreadId) : null,
  );
  const queryClient = useQueryClient();
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set());
  const [isEditingFiles, setIsEditingFiles] = useState(false);
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<PendingDefaultBranchAction | null>(null);

  const { data: gitStatus = null, error: gitStatusError } = useQuery(
    gitStatusQueryOptions(gitCwd, executionTargetId),
  );
  // Default to true while loading so we don't flash init controls.
  const isRepo = gitStatus?.isRepo ?? true;
  const hasOriginRemote = gitStatus?.hasOriginRemote ?? false;
  const gitStatusForActions = gitStatus;
  const isSelectingDraftWorktreeBase =
    !activeServerThread &&
    activeDraftThread?.envMode === "worktree" &&
    activeDraftThread.worktreePath === null;

  const allFiles = gitStatusForActions?.workingTree.files ?? [];
  const selectedFiles = allFiles.filter((f) => !excludedFiles.has(f.path));
  const allSelected = excludedFiles.size === 0;

  const initMutation = useMutation(
    gitInitMutationOptions({ cwd: gitCwd, executionTargetId, queryClient }),
  );
  const pullMutation = useMutation(
    gitPullMutationOptions({ cwd: gitCwd, executionTargetId, queryClient }),
  );

  const isRunStackedActionRunning =
    useIsMutating({ mutationKey: gitMutationKeys.runStackedAction(gitCwd, executionTargetId) }) > 0;
  const isPullRunning =
    useIsMutating({ mutationKey: gitMutationKeys.pull(gitCwd, executionTargetId) }) > 0;
  const isGitActionRunning = isRunStackedActionRunning || isPullRunning;

  const isDefaultBranch = useMemo(() => {
    return gitStatusForActions?.isDefaultBranch ?? false;
  }, [gitStatusForActions?.isDefaultBranch]);

  const { runGitActionWithToast, persistThreadBranchSync } = useGitActionRunner({
    gitCwd,
    executionTargetId,
    activeThreadId,
    isDefaultBranch,
    gitStatusForActions,
    threadToastData,
    callbacks: {
      onRequestDefaultBranchConfirmation: (params) => {
        setPendingDefaultBranchAction(params);
      },
    },
  });

  useEffect(() => {
    if (isGitActionRunning || isSelectingDraftWorktreeBase) return;

    const branchUpdate = resolveLiveThreadBranchUpdate({
      threadBranch: activeServerThread?.branch ?? activeDraftThread?.branch ?? null,
      gitStatus: gitStatusForActions,
    });
    if (!branchUpdate) return;

    persistThreadBranchSync(branchUpdate.branch);
  }, [
    activeDraftThread?.branch,
    activeServerThread?.branch,
    gitStatusForActions,
    isSelectingDraftWorktreeBase,
    isGitActionRunning,
    persistThreadBranchSync,
  ]);

  const gitActionMenuItems = useMemo(
    () => buildMenuItems(gitStatusForActions, isGitActionRunning, hasOriginRemote),
    [gitStatusForActions, hasOriginRemote, isGitActionRunning],
  );
  const quickAction = useMemo(
    () =>
      resolveQuickAction(gitStatusForActions, isGitActionRunning, isDefaultBranch, hasOriginRemote),
    [gitStatusForActions, hasOriginRemote, isDefaultBranch, isGitActionRunning],
  );
  const quickActionDisabledReason = quickAction.disabled
    ? (quickAction.hint ?? "This action is currently unavailable.")
    : null;
  const pendingDefaultBranchActionCopy = pendingDefaultBranchAction
    ? resolveDefaultBranchActionDialogCopy({
        action: pendingDefaultBranchAction.action,
        branchName: pendingDefaultBranchAction.branchName,
        includesCommit: pendingDefaultBranchAction.includesCommit,
      })
    : null;

  const openExistingPr = useCallback(async () => {
    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
        data: threadToastData,
      });
      return;
    }
    const prUrl = gitStatusForActions?.pr?.state === "open" ? gitStatusForActions.pr.url : null;
    if (!prUrl) {
      toastManager.add({
        type: "error",
        title: "No open PR found.",
        data: threadToastData,
      });
      return;
    }
    void api.shell.openExternal(prUrl).catch((err) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: threadToastData,
      });
    });
  }, [gitStatusForActions, threadToastData]);

  const continuePendingDefaultBranchAction = () => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, onConfirmed, filePaths } = pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      skipDefaultBranchPrompt: true,
    });
  };

  const checkoutFeatureBranchAndContinuePendingAction = () => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, onConfirmed, filePaths } = pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      featureBranch: true,
      skipDefaultBranchPrompt: true,
    });
  };

  const runDialogActionOnNewBranch = () => {
    if (!isCommitDialogOpen) return;
    const commitMessage = dialogCommitMessage.trim();
    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    setExcludedFiles(new Set());
    setIsEditingFiles(false);
    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((f) => f.path) } : {}),
      featureBranch: true,
      skipDefaultBranchPrompt: true,
    });
  };

  const runQuickAction = () => {
    if (quickAction.kind === "open_pr") {
      void openExistingPr();
      return;
    }
    if (quickAction.kind === "run_pull") {
      const promise = pullMutation.mutateAsync();
      toastManager.promise(promise, {
        loading: { title: "Pulling...", data: threadToastData },
        success: (result) => ({
          title: result.status === "pulled" ? "Pulled" : "Already up to date",
          description:
            result.status === "pulled"
              ? `Updated ${result.branch} from ${result.upstreamBranch ?? "upstream"}`
              : `${result.branch} is already synchronized.`,
          data: threadToastData,
        }),
        error: (err) => ({
          title: "Pull failed",
          description: err instanceof Error ? err.message : "An error occurred.",
          data: threadToastData,
        }),
      });
      void promise.catch(() => undefined);
      return;
    }
    if (quickAction.kind === "show_hint") {
      toastManager.add({
        type: "info",
        title: quickAction.label,
        description: quickAction.hint,
        data: threadToastData,
      });
      return;
    }
    if (quickAction.action) {
      void runGitActionWithToast({ action: quickAction.action });
    }
  };

  const openDialogForMenuItem = (item: GitActionMenuItem) => {
    if (item.disabled) return;
    if (item.kind === "open_pr") {
      void openExistingPr();
      return;
    }
    if (item.dialogAction === "push") {
      void runGitActionWithToast({ action: "push" });
      return;
    }
    if (item.dialogAction === "create_pr") {
      void runGitActionWithToast({ action: "create_pr" });
      return;
    }
    setExcludedFiles(new Set());
    setIsEditingFiles(false);
    setIsCommitDialogOpen(true);
  };

  const runDialogAction = () => {
    if (!isCommitDialogOpen) return;
    const commitMessage = dialogCommitMessage.trim();
    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    setExcludedFiles(new Set());
    setIsEditingFiles(false);
    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((f) => f.path) } : {}),
    });
  };

  const openChangedFileInEditor = useCallback(
    (filePath: string) => {
      const api = readNativeApi();
      if (!api || !gitCwd) {
        toastManager.add({
          type: "error",
          title: "Editor opening is unavailable.",
          data: threadToastData,
        });
        return;
      }
      const target = resolvePathLinkTarget(filePath, gitCwd);
      void openInPreferredEditor(api, target).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Unable to open file",
          description: error instanceof Error ? error.message : "An error occurred.",
          data: threadToastData,
        });
      });
    },
    [gitCwd, threadToastData],
  );

  const resetCommitDialog = () => {
    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    setExcludedFiles(new Set());
    setIsEditingFiles(false);
  };

  if (!gitCwd) return null;

  return (
    <>
      <GitActionsControlActions
        gitCwd={gitCwd}
        queryClient={queryClient}
        isRepo={isRepo}
        isInitPending={initMutation.isPending}
        isGitActionRunning={isGitActionRunning}
        hasOriginRemote={hasOriginRemote}
        gitStatusForActions={gitStatusForActions}
        gitStatusError={gitStatusError}
        gitActionMenuItems={gitActionMenuItems}
        quickAction={quickAction}
        quickActionDisabledReason={quickActionDisabledReason}
        onInit={() => initMutation.mutate()}
        onRunQuickAction={runQuickAction}
        onOpenDialogForMenuItem={openDialogForMenuItem}
      />

      <CommitDialog
        open={isCommitDialogOpen}
        onOpenChange={(open) => {
          if (!open) resetCommitDialog();
        }}
        gitStatus={gitStatusForActions}
        isDefaultBranch={isDefaultBranch}
        dialogCommitMessage={dialogCommitMessage}
        onCommitMessageChange={setDialogCommitMessage}
        excludedFiles={excludedFiles}
        onExcludedFilesChange={setExcludedFiles}
        isEditingFiles={isEditingFiles}
        onEditingFilesChange={setIsEditingFiles}
        onCancel={resetCommitDialog}
        onCommitOnNewBranch={runDialogActionOnNewBranch}
        onCommit={runDialogAction}
        onOpenChangedFileInEditor={openChangedFileInEditor}
      />

      <DefaultBranchDialog
        open={pendingDefaultBranchAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDefaultBranchAction(null);
        }}
        copy={pendingDefaultBranchActionCopy}
        onAbort={() => setPendingDefaultBranchAction(null)}
        onContinueOnDefaultBranch={continuePendingDefaultBranchAction}
        onCheckoutFeatureBranch={checkoutFeatureBranchAndContinuePendingAction}
      />
    </>
  );
}
