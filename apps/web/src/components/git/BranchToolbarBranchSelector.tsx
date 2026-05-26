import type { GitBranch } from "@bigbud/contracts";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, GitBranchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useOptimistic, useState, useTransition } from "react";

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
  getBranchTriggerLabel,
  resolveBranchSelectionTarget,
  toBranchActionErrorMessage,
} from "./BranchToolbarBranchSelector.helpers";
import { renderBranchPickerItem } from "./BranchToolbarBranchSelector.render";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxList,
  ComboboxPopup,
  ComboboxStatus,
  ComboboxTrigger,
} from "../ui/combobox";
import { Searchbar } from "../ui/Searchbar";
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
    branchPickerItems,
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
  const branchStatusText = isBranchesSearchPending
    ? "Loading branches..."
    : isFetchingNextPage
      ? "Loading more branches..."
      : hasNextPage
        ? `Showing ${branches.length} of ${totalBranchCount} branches`
        : null;

  const runBranchAction = (action: () => Promise<void>) => {
    startBranchActionTransition(async () => {
      await action().catch(() => undefined);
      await invalidateGitQueries(queryClient).catch(() => undefined);
    });
  };

  const selectBranch = (branch: GitBranch) => {
    const api = readNativeApi();
    if (!api || !branchCwd || isBranchActionPending) return;

    // In new-worktree mode, selecting a branch sets the base branch.
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

    // If the branch already lives in a worktree, point the thread there.
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

  const handleValueChange = (itemValue: string | null) => {
    if (!itemValue) {
      return;
    }
    if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
      if (!prReference || !onCheckoutPullRequestRequest) {
        return;
      }
      setIsBranchMenuOpen(false);
      setBranchQuery("");
      onComposerFocusRequest?.();
      onCheckoutPullRequestRequest(prReference);
      return;
    }
    if (createBranchItemValue && itemValue === createBranchItemValue) {
      createBranch(trimmedBranchQuery);
      return;
    }

    const branch = branchByName.get(itemValue);
    if (!branch) {
      return;
    }

    selectBranch(branch);
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
    <Combobox
      items={branchPickerItems}
      filteredItems={filteredBranchPickerItems}
      autoHighlight
      onOpenChange={handleOpenChange}
      onValueChange={handleValueChange}
      open={isBranchMenuOpen}
      value={resolvedActiveBranch}
    >
      <ComboboxTrigger
        render={<Button variant="ghost" size="xs" />}
        className="text-muted-foreground/70 hover:text-foreground/80"
        disabled={(isBranchesSearchPending && branches.length === 0) || isBranchActionPending}
      >
        <GitBranchIcon className="size-3" />
        <span className="max-w-[240px] truncate">{triggerLabel}</span>
        <ChevronDownIcon className="size-3" />
      </ComboboxTrigger>
      <ComboboxPopup align="end" side="top" className="w-80">
        <Searchbar
          showSearchIcon={false}
          canClear={branchQuery.length > 0}
          onClear={() => setBranchQuery("")}
        >
          <ComboboxInput
            className="rounded-none border-transparent! bg-transparent! shadow-none before:hidden has-focus-within:ring-0 has-focus-visible:ring-0 [&_input]:bg-transparent [&_input]:px-0 [&_input]:py-0.5 [&_input]:font-sans [&_input]:text-xs [&_input]:tracking-tight [&_input]:placeholder:text-xs [&_input]:placeholder:tracking-tight [&_input]:placeholder:text-muted-foreground/50"
            inputClassName="ring-0"
            onKeyDown={(event) => {
              event.stopPropagation();
            }}
            placeholder="Search branches"
            showTrigger={false}
            size="sm"
            value={branchQuery}
            onChange={(event) => setBranchQuery(event.target.value)}
          />
        </Searchbar>
        <ComboboxEmpty>No branches found.</ComboboxEmpty>

        <ComboboxList className="max-h-56">
          {filteredBranchPickerItems.map((itemValue, index) =>
            renderBranchPickerItem({
              itemValue,
              index,
              checkoutPullRequestItemValue,
              createBranchItemValue,
              prReference,
              trimmedBranchQuery,
              branchByName,
              activeProjectCwd,
            }),
          )}
        </ComboboxList>
        {branchStatusText ? <ComboboxStatus>{branchStatusText}</ComboboxStatus> : null}
      </ComboboxPopup>
    </Combobox>
  );
}
