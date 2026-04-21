import type {
  GitActionProgressEvent,
  GitRunStackedActionResult,
  GitStackedAction,
  GitStatusResult,
  ThreadId,
} from "@bigbud/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useEffectEvent, useRef } from "react";
import {
  buildGitActionProgressStages,
  type DefaultBranchConfirmableAction,
  requiresDefaultBranchConfirmation,
  resolveProgressDescription,
  resolveThreadBranchUpdate,
} from "./GitActionsControl.logic";
import { toastManager, type ThreadToastData } from "~/components/ui/toast";
import { gitMutationKeys, gitRunStackedActionMutationOptions } from "~/lib/gitReactQuery";
import { newCommandId, randomUUID } from "~/lib/utils";
import { readNativeApi } from "../../rpc/nativeApi";
import { useComposerDraftStore } from "../../stores/composer";
import { useStore } from "../../stores/main";

type GitActionToastId = ReturnType<typeof toastManager.add>;

interface ActiveGitActionProgress {
  toastId: GitActionToastId;
  toastData: ThreadToastData | undefined;
  actionId: string;
  title: string;
  phaseStartedAtMs: number | null;
  hookStartedAtMs: number | null;
  hookName: string | null;
  lastOutputLine: string | null;
  currentPhaseLabel: string | null;
}

export interface RunGitActionWithToastInput {
  action: GitStackedAction;
  commitMessage?: string;
  onConfirmed?: () => void;
  skipDefaultBranchPrompt?: boolean;
  statusOverride?: GitStatusResult | null;
  featureBranch?: boolean;
  progressToastId?: GitActionToastId;
  filePaths?: string[];
}

export interface GitActionRunnerCallbacks {
  onRequestDefaultBranchConfirmation: (params: {
    action: DefaultBranchConfirmableAction;
    branchName: string;
    includesCommit: boolean;
    commitMessage?: string;
    onConfirmed?: () => void;
    filePaths?: string[];
  }) => void;
}

interface UseGitActionRunnerInput {
  gitCwd: string | null;
  activeThreadId: ThreadId | null;
  isDefaultBranch: boolean;
  gitStatusForActions: GitStatusResult | null;
  threadToastData: ThreadToastData | undefined;
  callbacks: GitActionRunnerCallbacks;
}

export function useGitActionRunner({
  gitCwd,
  activeThreadId,
  isDefaultBranch,
  gitStatusForActions,
  threadToastData,
  callbacks,
}: UseGitActionRunnerInput) {
  const activeServerThread = useStore((store) =>
    activeThreadId ? store.threads.find((thread) => thread.id === activeThreadId) : undefined,
  );
  const activeDraftThread = useComposerDraftStore((store) =>
    activeThreadId ? store.getDraftThread(activeThreadId) : null,
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const setThreadBranch = useStore((store) => store.setThreadBranch);
  const queryClient = useQueryClient();
  const activeGitActionProgressRef = useRef<ActiveGitActionProgress | null>(null);

  const runImmediateGitActionMutation = useMutation(
    gitRunStackedActionMutationOptions({ cwd: gitCwd, queryClient }),
  );

  const isRunning = runImmediateGitActionMutation.isPending;

  const updateActiveProgressToast = useCallback(() => {
    const progress = activeGitActionProgressRef.current;
    if (!progress) return;
    toastManager.update(progress.toastId, {
      type: "loading",
      title: progress.title,
      description: resolveProgressDescription(progress),
      timeout: 0,
      data: progress.toastData,
    });
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!activeGitActionProgressRef.current) return;
      updateActiveProgressToast();
    }, 1000);
    return () => window.clearInterval(interval);
  }, [updateActiveProgressToast]);

  const persistThreadBranchSync = useCallback(
    (branch: string | null) => {
      if (!activeThreadId) {
        return;
      }

      if (activeServerThread) {
        if (activeServerThread.branch === branch) {
          return;
        }

        const worktreePath = activeServerThread.worktreePath;
        const api = readNativeApi();
        if (api) {
          void api.orchestration
            .dispatchCommand({
              type: "thread.meta.update",
              commandId: newCommandId(),
              threadId: activeThreadId,
              branch,
              worktreePath,
            })
            .catch(() => undefined);
        }
        setThreadBranch(activeThreadId, branch, worktreePath);
        return;
      }

      if (!activeDraftThread || activeDraftThread.branch === branch) {
        return;
      }

      setDraftThreadContext(activeThreadId, {
        branch,
        worktreePath: activeDraftThread.worktreePath,
      });
    },
    [activeDraftThread, activeServerThread, activeThreadId, setDraftThreadContext, setThreadBranch],
  );

  const syncThreadBranchAfterGitAction = useCallback(
    (result: GitRunStackedActionResult) => {
      const branchUpdate = resolveThreadBranchUpdate(result);
      if (branchUpdate) persistThreadBranchSync(branchUpdate.branch);
    },
    [persistThreadBranchSync],
  );

  let runGitActionWithToast: (input: RunGitActionWithToastInput) => Promise<void>;

  runGitActionWithToast = useEffectEvent(
    async ({
      action,
      commitMessage,
      onConfirmed,
      skipDefaultBranchPrompt = false,
      statusOverride,
      featureBranch = false,
      progressToastId,
      filePaths,
    }: RunGitActionWithToastInput) => {
      const actionStatus = statusOverride ?? gitStatusForActions;
      const actionBranch = actionStatus?.branch ?? null;
      const actionIsDefaultBranch = featureBranch ? false : isDefaultBranch;
      const actionCanCommit =
        action === "commit" || action === "commit_push" || action === "commit_push_pr";
      const includesCommit =
        actionCanCommit &&
        (action === "commit" || !!actionStatus?.hasWorkingTreeChanges || featureBranch);

      if (
        !skipDefaultBranchPrompt &&
        requiresDefaultBranchConfirmation(action, actionIsDefaultBranch) &&
        actionBranch
      ) {
        if (
          action !== "push" &&
          action !== "create_pr" &&
          action !== "commit_push" &&
          action !== "commit_push_pr"
        ) {
          return;
        }
        callbacks.onRequestDefaultBranchConfirmation({
          action,
          branchName: actionBranch,
          includesCommit,
          ...(commitMessage ? { commitMessage } : {}),
          ...(onConfirmed ? { onConfirmed } : {}),
          ...(filePaths ? { filePaths } : {}),
        });
        return;
      }
      onConfirmed?.();

      const progressStages = buildGitActionProgressStages({
        action,
        hasCustomCommitMessage: !!commitMessage?.trim(),
        hasWorkingTreeChanges: !!actionStatus?.hasWorkingTreeChanges,
        featureBranch,
        shouldPushBeforePr:
          action === "create_pr" &&
          (!actionStatus?.hasUpstream || (actionStatus?.aheadCount ?? 0) > 0),
      });
      const scopedToastData = threadToastData ? { ...threadToastData } : undefined;
      const actionId = randomUUID();
      const resolvedProgressToastId =
        progressToastId ??
        toastManager.add({
          type: "loading",
          title: progressStages[0] ?? "Running git action...",
          description: "Waiting for Git...",
          timeout: 0,
          data: scopedToastData,
        });

      activeGitActionProgressRef.current = {
        toastId: resolvedProgressToastId,
        toastData: scopedToastData,
        actionId,
        title: progressStages[0] ?? "Running git action...",
        phaseStartedAtMs: null,
        hookStartedAtMs: null,
        hookName: null,
        lastOutputLine: null,
        currentPhaseLabel: progressStages[0] ?? "Running git action...",
      };

      if (progressToastId) {
        toastManager.update(progressToastId, {
          type: "loading",
          title: progressStages[0] ?? "Running git action...",
          description: "Waiting for Git...",
          timeout: 0,
          data: scopedToastData,
        });
      }

      const applyProgressEvent = (event: GitActionProgressEvent) => {
        const progress = activeGitActionProgressRef.current;
        if (!progress) return;
        if (gitCwd && event.cwd !== gitCwd) return;
        if (progress.actionId !== event.actionId) return;

        const now = Date.now();
        switch (event.kind) {
          case "action_started":
            progress.phaseStartedAtMs = now;
            progress.hookStartedAtMs = null;
            progress.hookName = null;
            progress.lastOutputLine = null;
            break;
          case "phase_started":
            progress.title = event.label;
            progress.currentPhaseLabel = event.label;
            progress.phaseStartedAtMs = now;
            progress.hookStartedAtMs = null;
            progress.hookName = null;
            progress.lastOutputLine = null;
            break;
          case "hook_started":
            progress.title = `Running ${event.hookName}...`;
            progress.hookName = event.hookName;
            progress.hookStartedAtMs = now;
            progress.lastOutputLine = null;
            break;
          case "hook_output":
            progress.lastOutputLine = event.text;
            break;
          case "hook_finished":
            progress.title = progress.currentPhaseLabel ?? "Committing...";
            progress.hookName = null;
            progress.hookStartedAtMs = null;
            progress.lastOutputLine = null;
            break;
          case "action_finished":
            // Let the resolved mutation update the toast.
            return;
          case "action_failed":
            // Let the rejected mutation publish the error toast.
            return;
        }
        updateActiveProgressToast();
      };

      const promise = runImmediateGitActionMutation.mutateAsync({
        actionId,
        action,
        ...(commitMessage ? { commitMessage } : {}),
        ...(featureBranch ? { featureBranch } : {}),
        ...(filePaths ? { filePaths } : {}),
        onProgress: applyProgressEvent,
      });

      try {
        const result = await promise;
        activeGitActionProgressRef.current = null;
        syncThreadBranchAfterGitAction(result);
        const closeResultToast = () => toastManager.close(resolvedProgressToastId);

        const toastCta = result.toast.cta;
        let toastActionProps: { children: string; onClick: () => void } | null = null;
        if (toastCta.kind === "run_action") {
          toastActionProps = {
            children: toastCta.label,
            onClick: () => {
              closeResultToast();
              void runGitActionWithToast({ action: toastCta.action.kind });
            },
          };
        } else if (toastCta.kind === "open_pr") {
          toastActionProps = {
            children: toastCta.label,
            onClick: () => {
              const api = readNativeApi();
              if (!api) return;
              closeResultToast();
              void api.shell.openExternal(toastCta.url);
            },
          };
        }

        const successToastBase = {
          type: "success",
          title: result.toast.title,
          description: result.toast.description,
          timeout: 0,
          data: { ...scopedToastData, dismissAfterVisibleMs: 10_000 },
        } as const;

        if (toastActionProps) {
          toastManager.update(resolvedProgressToastId, {
            ...successToastBase,
            actionProps: toastActionProps,
          });
        } else {
          toastManager.update(resolvedProgressToastId, successToastBase);
        }
      } catch (err) {
        activeGitActionProgressRef.current = null;
        toastManager.update(resolvedProgressToastId, {
          type: "error",
          title: "Action failed",
          description: err instanceof Error ? err.message : "An error occurred.",
          data: scopedToastData,
        });
      }
    },
  );

  return {
    runGitActionWithToast,
    persistThreadBranchSync,
    isRunning,
    // Track current key for preventing stale running-state checks from outside
    runStackedActionKey: gitMutationKeys.runStackedAction(gitCwd),
  };
}
