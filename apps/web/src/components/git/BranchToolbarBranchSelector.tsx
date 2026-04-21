import type { GitBranch } from "@bigbud/contracts";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, GitBranchIcon } from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useOptimistic,
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
import { parsePullRequestReference } from "../../logic/pull-request";
import {
  deriveLocalBranchNameFromRemoteRef,
  EnvMode,
  resolveBranchSelectionTarget,
  resolveBranchToolbarValue,
  shouldIncludeBranchPickerItem,
} from "./BranchToolbar.logic";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxStatus,
  ComboboxTrigger,
} from "../ui/combobox";
import { Searchbar } from "../ui/Searchbar";
import { toastManager } from "../ui/toast";

interface BranchToolbarBranchSelectorProps {
  activeProjectCwd: string | null;
  activeThreadBranch: string | null;
  activeWorktreePath: string | null;
  branchCwd: string | null;
  effectiveEnvMode: EnvMode;
  envLocked: boolean;
  onSetThreadBranch: (branch: string | null, worktreePath: string | null) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
}

function toBranchActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

function getBranchTriggerLabel(input: {
  activeWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
  resolvedActiveBranch: string | null;
}): string {
  const { activeWorktreePath, effectiveEnvMode, resolvedActiveBranch } = input;
  if (!resolvedActiveBranch) {
    return "Select branch";
  }
  if (effectiveEnvMode === "worktree" && !activeWorktreePath) {
    return `From ${resolvedActiveBranch}`;
  }
  return resolvedActiveBranch;
}

export function BranchToolbarBranchSelector({
  activeProjectCwd,
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

  const branchStatusQuery = useQuery(gitStatusQueryOptions(branchCwd));
  const trimmedBranchQuery = branchQuery.trim();

  useEffect(() => {
    if (!branchCwd) return;
    void queryClient.prefetchInfiniteQuery(
      gitBranchSearchInfiniteQueryOptions({ cwd: branchCwd, query: "" }),
    );
  }, [branchCwd, queryClient]);

  const {
    data: branchesSearchData,
    hasNextPage,
    isFetchingNextPage,
    isPending: isBranchesSearchPending,
  } = useInfiniteQuery(
    gitBranchSearchInfiniteQueryOptions({
      cwd: branchCwd,
      query: trimmedBranchQuery,
      enabled: isBranchMenuOpen,
    }),
  );
  const branches = useMemo(
    () => branchesSearchData?.pages.flatMap((page) => page.branches) ?? [],
    [branchesSearchData?.pages],
  );
  const currentGitBranch =
    branchStatusQuery.data?.branch ?? branches.find((branch) => branch.current)?.name ?? null;
  const canonicalActiveBranch = resolveBranchToolbarValue({
    envMode: effectiveEnvMode,
    activeWorktreePath,
    activeThreadBranch,
    currentGitBranch,
  });
  const branchNames = useMemo(() => branches.map((branch) => branch.name), [branches]);
  const branchByName = useMemo(
    () => new Map(branches.map((branch) => [branch.name, branch] as const)),
    [branches],
  );
  const normalizedBranchQuery = trimmedBranchQuery.toLowerCase();
  const prReference = parsePullRequestReference(trimmedBranchQuery);
  const isSelectingWorktreeBase =
    effectiveEnvMode === "worktree" && !envLocked && !activeWorktreePath;
  const checkoutPullRequestItemValue =
    prReference && onCheckoutPullRequestRequest ? `__checkout_pull_request__:${prReference}` : null;
  const canCreateBranch = !isSelectingWorktreeBase && trimmedBranchQuery.length > 0;
  const hasExactBranchMatch = branchByName.has(trimmedBranchQuery);
  const createBranchItemValue = canCreateBranch
    ? `__create_new_branch__:${trimmedBranchQuery}`
    : null;
  const branchPickerItems = useMemo(() => {
    const items = [...branchNames];
    if (createBranchItemValue && !hasExactBranchMatch) {
      items.push(createBranchItemValue);
    }
    if (checkoutPullRequestItemValue) {
      items.unshift(checkoutPullRequestItemValue);
    }
    return items;
  }, [branchNames, checkoutPullRequestItemValue, createBranchItemValue, hasExactBranchMatch]);
  const filteredBranchPickerItems = useMemo(
    () =>
      normalizedBranchQuery.length === 0
        ? branchPickerItems
        : branchPickerItems.filter((itemValue) =>
            shouldIncludeBranchPickerItem({
              itemValue,
              normalizedQuery: normalizedBranchQuery,
              createBranchItemValue,
              checkoutPullRequestItemValue,
            }),
          ),
    [branchPickerItems, checkoutPullRequestItemValue, createBranchItemValue, normalizedBranchQuery],
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

    const selectedBranchName = branch.isRemote
      ? deriveLocalBranchNameFromRemoteRef(branch.name)
      : branch.name;

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      setOptimisticBranch(selectedBranchName);
      try {
        await api.git.checkout({ cwd: selectionTarget.checkoutCwd, branch: branch.name });
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
          .refreshStatus({ cwd: selectionTarget.checkoutCwd })
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
        await api.git.createBranch({ cwd: branchCwd, branch: name });
        try {
          await api.git.checkout({ cwd: branchCwd, branch: name });
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
        queryKey: gitQueryKeys.branches(branchCwd),
      });
    },
    [branchCwd, queryClient],
  );

  const triggerLabel = getBranchTriggerLabel({
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
  });

  function renderPickerItem(itemValue: string, index: number, style?: CSSProperties) {
    if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
      return (
        <ComboboxItem hideIndicator key={itemValue} index={index} value={itemValue} style={style}>
          <div className="flex min-w-0 flex-col items-start py-1">
            <span className="truncate font-medium">Checkout Pull Request</span>
            <span className="truncate text-muted-foreground text-xs">{prReference}</span>
          </div>
        </ComboboxItem>
      );
    }
    if (createBranchItemValue && itemValue === createBranchItemValue) {
      return (
        <ComboboxItem hideIndicator key={itemValue} index={index} value={itemValue} style={style}>
          <span className="truncate">Create new branch "{trimmedBranchQuery}"</span>
        </ComboboxItem>
      );
    }

    const branch = branchByName.get(itemValue);
    if (!branch) return null;

    const hasSecondaryWorktree = branch.worktreePath && branch.worktreePath !== activeProjectCwd;
    const badge = branch.current
      ? "current"
      : hasSecondaryWorktree
        ? "worktree"
        : branch.isRemote
          ? "remote"
          : branch.isDefault
            ? "default"
            : null;
    return (
      <ComboboxItem hideIndicator key={itemValue} index={index} value={itemValue} style={style}>
        <div className="flex w-full items-center justify-between gap-2">
          <span className="truncate">{itemValue}</span>
          {badge && <span className="shrink-0 text-[10px] text-muted-foreground/45">{badge}</span>}
        </div>
      </ComboboxItem>
    );
  }

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
        <ChevronDownIcon />
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
          {filteredBranchPickerItems.map((itemValue, index) => renderPickerItem(itemValue, index))}
        </ComboboxList>
        {branchStatusText ? <ComboboxStatus>{branchStatusText}</ComboboxStatus> : null}
      </ComboboxPopup>
    </Combobox>
  );
}
