import type { ThreadId } from "@bigbud/contracts";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import {
  buildMenuItems,
  type DefaultBranchConfirmableAction,
  type GitActionMenuItem,
  resolveDefaultBranchActionDialogCopy,
  resolveLiveThreadBranchUpdate,
} from "./GitActionsControl.logic";
import { GitActionsControlActions } from "./GitActionsControl.actions";
import { CommitDialog } from "./GitActionsControl.commitDialog";
import { DefaultBranchDialog } from "./GitActionsControl.defaultBranchDialog";
import { useGitActionRunner } from "./GitActionsControl.runner";
import { toastManager } from "~/components/ui/toast";
import { openInPreferredEditor } from "../../models/editor";
import {
  gitDiscardChangesMutationOptions,
  gitFetchMutationOptions,
  gitInitMutationOptions,
  gitMutationKeys,
  gitPullMutationOptions,
  gitStatusQueryOptions,
} from "~/lib/gitReactQuery";
import { resolvePathLinkTarget } from "../../utils/terminal";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { readNativeApi } from "../../rpc/nativeApi";
import { openGitPanelToView } from "~/stores/git/gitPanel.coordinator";
import { useComposerDraftStore } from "../../stores/composer";
import { useStore } from "../../stores/main";
import { useEffect } from "react";

interface GitActionsControlProps {
  gitCwd: string | null;
  isProjectThread?: boolean;
  executionTargetId?: string | undefined;
  activeThreadId: ThreadId | null;
  onOpenOrchestra?: (() => void) | undefined;
  planCardLabel?: string | undefined;
  planCardOpen?: boolean | undefined;
  onTogglePlanCard?: (() => void) | undefined;
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
  isProjectThread = true,
  executionTargetId,
  activeThreadId,
  onOpenOrchestra,
  planCardLabel,
  planCardOpen,
  onTogglePlanCard,
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
  const [isDiscardConfirmOpen, setIsDiscardConfirmOpen] = useState(false);
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<PendingDefaultBranchAction | null>(null);

  const { data: gitStatus = null, error: gitStatusError } = useQuery(
    gitStatusQueryOptions(gitCwd, executionTargetId),
  );
  // Default to true while loading so we don't flash init controls.
  const isRepo = gitStatus?.isRepo ?? true;
  const hasOriginRemote = gitStatus?.hasOriginRemote ?? false;
  const gitStatusForActions = gitStatus;
  const showGit = isProjectThread || gitStatus?.isRepo === true;
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
  const fetchMutation = useMutation(
    gitFetchMutationOptions({ cwd: gitCwd, executionTargetId, queryClient }),
  );
  const discardMutation = useMutation(
    gitDiscardChangesMutationOptions({ cwd: gitCwd, executionTargetId, queryClient }),
  );

  const isRunStackedActionRunning =
    useIsMutating({ mutationKey: gitMutationKeys.runStackedAction(gitCwd, executionTargetId) }) > 0;
  const isPullRunning =
    useIsMutating({ mutationKey: gitMutationKeys.pull(gitCwd, executionTargetId) }) > 0;
  const isFetchRunning =
    useIsMutating({ mutationKey: gitMutationKeys.fetch(gitCwd, executionTargetId) }) > 0;
  const isDiscardRunning =
    useIsMutating({ mutationKey: gitMutationKeys.discardChanges(gitCwd, executionTargetId) }) > 0;
  const isGitActionRunning =
    isRunStackedActionRunning || isPullRunning || isFetchRunning || isDiscardRunning;

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
  const pendingDefaultBranchActionCopy = pendingDefaultBranchAction
    ? resolveDefaultBranchActionDialogCopy({
        action: pendingDefaultBranchAction.action,
        branchName: pendingDefaultBranchAction.branchName,
        includesCommit: pendingDefaultBranchAction.includesCommit,
      })
    : null;

  const runPull = useCallback(() => {
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
  }, [pullMutation, threadToastData]);

  const runFetch = useCallback(() => {
    const promise = fetchMutation.mutateAsync();
    toastManager.promise(promise, {
      loading: { title: "Fetching...", data: threadToastData },
      success: () => ({
        title: "Fetched",
        description: "Remote refs are up to date.",
        data: threadToastData,
      }),
      error: (err) => ({
        title: "Fetch failed",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: threadToastData,
      }),
    });
    void promise.catch(() => undefined);
  }, [fetchMutation, threadToastData]);

  const runDiscard = useCallback(() => {
    const promise = discardMutation.mutateAsync();
    toastManager.promise(promise, {
      loading: { title: "Discarding changes...", data: threadToastData },
      success: () => ({
        title: "Discarded changes",
        description: "Working tree has been reset to HEAD.",
        data: threadToastData,
      }),
      error: (err) => ({
        title: "Discard failed",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: threadToastData,
      }),
    });
    void promise.catch(() => undefined);
  }, [discardMutation, threadToastData]);

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

  const handleMenuItemSelect = useCallback(
    (item: GitActionMenuItem) => {
      if (item.disabled) return;

      if (item.id === "initialize_git") {
        initMutation.mutate();
        return;
      }

      if (item.kind === "open_panel") {
        openGitPanelToView(item.panelAction ?? "changes");
        return;
      }

      if (item.action === "pull") {
        runPull();
        return;
      }

      if (item.action === "fetch") {
        runFetch();
        return;
      }

      if (item.action === "discard") {
        setIsDiscardConfirmOpen(true);
        return;
      }

      if (item.dialogAction === "push") {
        void runGitActionWithToast({ action: "push" });
        return;
      }

      // Default to opening the commit dialog for commit or any other dialog action.
      setExcludedFiles(new Set());
      setIsEditingFiles(false);
      setIsCommitDialogOpen(true);
    },
    [initMutation, runPull, runFetch, runGitActionWithToast],
  );

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

  return (
    <>
      <GitActionsControlActions
        gitCwd={gitCwd}
        showGit={showGit}
        queryClient={queryClient}
        isRepo={isRepo}
        isInitPending={initMutation.isPending}
        isGitActionRunning={isGitActionRunning}
        hasOriginRemote={hasOriginRemote}
        gitStatusForActions={gitStatusForActions}
        gitStatusError={gitStatusError}
        gitActionMenuItems={gitActionMenuItems}
        onOpenOrchestra={onOpenOrchestra}
        planCardLabel={planCardLabel}
        planCardOpen={planCardOpen}
        onMenuItemSelect={handleMenuItemSelect}
        onTogglePlanCard={onTogglePlanCard}
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

      <Dialog open={isDiscardConfirmOpen} onOpenChange={setIsDiscardConfirmOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Discard all changes?</DialogTitle>
            <DialogDescription>
              This will reset the working tree to the last commit. All uncommitted changes will be
              permanently lost. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <DialogFooter>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setIsDiscardConfirmOpen(false);
                  runDiscard();
                }}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                Discard changes
              </Button>
              <Button variant="outline" size="sm" onClick={() => setIsDiscardConfirmOpen(false)}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
