import type { GitBranch } from "@bigbud/contracts";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, GitBranchIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";

import {
  gitBranchSearchInfiniteQueryOptions,
  gitQueryKeys,
  gitStatusQueryOptions,
  invalidateGitQueries,
} from "../../lib/gitReactQuery";
import { readNativeApi } from "../../rpc/nativeApi";
import { EnvMode } from "./BranchToolbar.logic";
import {
  deriveBranchSelectorState,
  deriveSelectedBranchName,
  getBranchStatusText,
  getBranchTriggerLabel,
  resolveBranchSelectionTarget,
  toBranchActionErrorMessage,
} from "./BranchToolbarBranchSelector.helpers";
import { BranchToolbarBranchActionDialogs } from "./BranchToolbarBranchActions.dialogs";
import { BranchToolbarBranchSelectorPopup } from "./BranchToolbarBranchSelector.render";
import { Button } from "../ui/button";
import { Menu, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";

interface BranchToolbarBranchSelectorProps {
  activeProjectCwd: string | null;
  executionTargetId?: string | undefined;
  activeThreadBranch: string | null;
  activeWorktreePath: string | null;
  branchCwd: string | null;
  effectiveEnvMode: EnvMode;
  envLocked: boolean;
  onSetThreadBranch: (branch: string | null, worktreePath: string | null) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
}

export function BranchToolbarBranchSelector({
  activeProjectCwd,
  executionTargetId,
  activeThreadBranch,
  activeWorktreePath,
  branchCwd,
  effectiveEnvMode,
  envLocked,
  onSetThreadBranch,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
}: BranchToolbarBranchSelectorProps) {
  const queryClient = useQueryClient();
  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [renameBranchTarget, setRenameBranchTarget] = useState<GitBranch | null>(null);
  const [deleteBranchTarget, setDeleteBranchTarget] = useState<GitBranch | null>(null);
  const branchSearchInputRef = useRef<HTMLInputElement>(null);

  const branchStatusQuery = useQuery(gitStatusQueryOptions(branchCwd, executionTargetId));
  const trimmedBranchQuery = branchQuery.trim();

  useEffect(() => {
    if (!branchCwd) return;
    void queryClient.prefetchInfiniteQuery(
      gitBranchSearchInfiniteQueryOptions({
        cwd: branchCwd,
        executionTargetId,
        query: "",
      }),
    );
  }, [branchCwd, executionTargetId, queryClient]);

  const {
    data: branchesSearchData,
    hasNextPage,
    isFetchingNextPage,
    isPending: isBranchesSearchPending,
  } = useInfiniteQuery(
    gitBranchSearchInfiniteQueryOptions({
      cwd: branchCwd,
      executionTargetId,
      query: trimmedBranchQuery,
      enabled: isBranchMenuOpen,
    }),
  );
  const branches = useMemo(
    () => branchesSearchData?.pages.flatMap((page) => page.branches) ?? [],
    [branchesSearchData?.pages],
  );
  const {
    currentGitBranch,
    canonicalActiveBranch,
    branchByName,
    prReference,
    isSelectingWorktreeBase,
    checkoutPullRequestItemValue,
    createBranchItemValue,
    filteredBranchPickerItems,
  } = useMemo(
    () =>
      deriveBranchSelectorState({
        branches,
        branchQuery,
        branchStatusBranch: branchStatusQuery.data?.branch ?? null,
        effectiveEnvMode,
        envLocked,
        activeWorktreePath,
        activeThreadBranch,
        onCheckoutPullRequestRequest,
      }),
    [
      activeThreadBranch,
      activeWorktreePath,
      branchQuery,
      branchStatusQuery.data?.branch,
      branches,
      effectiveEnvMode,
      envLocked,
      onCheckoutPullRequestRequest,
    ],
  );
  const [resolvedActiveBranch, setOptimisticBranch] = useOptimistic(
    canonicalActiveBranch,
    (_currentBranch: string | null, optimisticBranch: string | null) => optimisticBranch,
  );
  const [isBranchActionPending, startBranchActionTransition] = useTransition();
  const totalBranchCount = branchesSearchData?.pages[0]?.totalCount ?? 0;
  const branchStatusText = getBranchStatusText({
    isPending: isBranchesSearchPending,
    isFetchingNextPage,
    hasNextPage,
    visibleCount: branches.length,
    totalCount: totalBranchCount,
  });

  const runBranchAction = (action: () => Promise<void>) => {
    startBranchActionTransition(async () => {
      await action().catch(() => undefined);
      await invalidateGitQueries(queryClient).catch(() => undefined);
    });
  };

  const selectBranch = (branch: GitBranch) => {
    const api = readNativeApi();
    if (!api || !branchCwd || isBranchActionPending) return;

    if (isSelectingWorktreeBase) {
      onSetThreadBranch(branch.name, null);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectionTarget = resolveBranchSelectionTarget({
      activeProjectCwd,
      activeWorktreePath,
      branch,
    });

    if (selectionTarget.reuseExistingWorktree) {
      onSetThreadBranch(branch.name, selectionTarget.nextWorktreePath);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectedBranchName = deriveSelectedBranchName(branch);

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      setOptimisticBranch(selectedBranchName);
      try {
        await api.git.checkout({
          cwd: selectionTarget.checkoutCwd,
          ...(executionTargetId ? { executionTargetId } : {}),
          branch: branch.name,
        });
        await invalidateGitQueries(queryClient);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to checkout branch.",
          description: toBranchActionErrorMessage(error),
        });
        return;
      }

      let nextBranchName = selectedBranchName;
      if (branch.isRemote) {
        const status = await api.git
          .refreshStatus({
            cwd: selectionTarget.checkoutCwd,
            ...(executionTargetId ? { executionTargetId } : {}),
          })
          .catch(() => null);
        if (status?.branch) {
          nextBranchName = status.branch;
        }
      }

      setOptimisticBranch(nextBranchName);
      onSetThreadBranch(nextBranchName, selectionTarget.nextWorktreePath);
    });
  };

  const createBranch = (rawName: string) => {
    const name = rawName.trim();
    const api = readNativeApi();
    if (!api || !branchCwd || !name || isBranchActionPending) return;

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      setOptimisticBranch(name);

      try {
        await api.git.createBranch({
          cwd: branchCwd,
          ...(executionTargetId ? { executionTargetId } : {}),
          branch: name,
        });
        try {
          await api.git.checkout({
            cwd: branchCwd,
            ...(executionTargetId ? { executionTargetId } : {}),
            branch: name,
          });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to checkout branch.",
            description: toBranchActionErrorMessage(error),
          });
          return;
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to create branch.",
          description: toBranchActionErrorMessage(error),
        });
        return;
      }

      setOptimisticBranch(name);
      onSetThreadBranch(name, activeWorktreePath);
      setBranchQuery("");
    });
  };

  const renameBranch = async (branch: GitBranch, newName: string) => {
    const api = readNativeApi();
    if (!api || !branchCwd) return;
    const result = await api.git.renameBranch({
      cwd: branchCwd,
      ...(executionTargetId ? { executionTargetId } : {}),
      oldBranch: branch.name,
      newBranch: newName,
    });
    await invalidateGitQueries(queryClient);
    if (branch.current || activeThreadBranch === branch.name) {
      onSetThreadBranch(result.branch, activeWorktreePath);
    }
  };

  const deleteBranch = async (branch: GitBranch) => {
    const api = readNativeApi();
    if (!api || !branchCwd) return;
    await api.git.deleteBranch({
      cwd: branchCwd,
      ...(executionTargetId ? { executionTargetId } : {}),
      branch: branch.name,
    });
    await invalidateGitQueries(queryClient);
  };

  const checkoutPullRequest = () => {
    if (!prReference || !onCheckoutPullRequestRequest) return;
    setIsBranchMenuOpen(false);
    setBranchQuery("");
    onComposerFocusRequest?.();
    onCheckoutPullRequestRequest(prReference);
  };

  useEffect(() => {
    if (
      effectiveEnvMode !== "worktree" ||
      activeWorktreePath ||
      activeThreadBranch ||
      !currentGitBranch
    ) {
      return;
    }
    onSetThreadBranch(currentGitBranch, null);
  }, [
    activeThreadBranch,
    activeWorktreePath,
    currentGitBranch,
    effectiveEnvMode,
    onSetThreadBranch,
  ]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsBranchMenuOpen(open);
      if (!open) {
        setBranchQuery("");
        return;
      }
      queueMicrotask(() => branchSearchInputRef.current?.focus());
      void queryClient.invalidateQueries({
        queryKey: gitQueryKeys.branches(branchCwd, executionTargetId),
      });
    },
    [branchCwd, executionTargetId, queryClient],
  );

  const triggerLabel = getBranchTriggerLabel({
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
  });

  return (
    <>
      <Menu open={isBranchMenuOpen} onOpenChange={handleOpenChange}>
        <MenuTrigger
          render={<Button variant="ghost" size="xs" />}
          className="text-muted-foreground/70 hover:text-foreground/80"
          disabled={(isBranchesSearchPending && branches.length === 0) || isBranchActionPending}
        >
          <GitBranchIcon className="size-3" />
          <span className="max-w-[240px] truncate">{triggerLabel}</span>
          <ChevronDownIcon className="size-3" />
        </MenuTrigger>
        <BranchToolbarBranchSelectorPopup
          inputRef={branchSearchInputRef}
          query={branchQuery}
          branchStatusText={branchStatusText}
          itemValues={filteredBranchPickerItems}
          checkoutPullRequestItemValue={checkoutPullRequestItemValue}
          createBranchItemValue={createBranchItemValue}
          prReference={prReference}
          trimmedBranchQuery={trimmedBranchQuery}
          branchByName={branchByName}
          activeProjectCwd={activeProjectCwd}
          isSelectingWorktreeBase={isSelectingWorktreeBase}
          actionPending={isBranchActionPending}
          onQueryChange={setBranchQuery}
          onSelect={selectBranch}
          onCheckoutPullRequest={checkoutPullRequest}
          onCreateBranch={() => createBranch(trimmedBranchQuery)}
          onRenameRequest={(branch) => setRenameBranchTarget(branch)}
          onDeleteRequest={(branch) => setDeleteBranchTarget(branch)}
        />
      </Menu>
      <BranchToolbarBranchActionDialogs
        renameBranch={renameBranchTarget}
        deleteBranch={deleteBranchTarget}
        onRenameOpenChange={(open) => !open && setRenameBranchTarget(null)}
        onDeleteOpenChange={(open) => !open && setDeleteBranchTarget(null)}
        onRename={renameBranch}
        onDelete={deleteBranch}
      />
    </>
  );
}
