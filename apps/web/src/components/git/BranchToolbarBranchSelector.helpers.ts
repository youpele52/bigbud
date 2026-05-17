import type { GitBranch } from "@bigbud/contracts";
import { parsePullRequestReference } from "../../logic/pull-request";
import {
  deriveLocalBranchNameFromRemoteRef,
  type EnvMode,
  resolveBranchSelectionTarget,
  resolveBranchToolbarValue,
  shouldIncludeBranchPickerItem,
} from "./BranchToolbar.logic";

export function toBranchActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

export function getBranchTriggerLabel(input: {
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

export function deriveBranchSelectorState(input: {
  branches: GitBranch[];
  branchQuery: string;
  branchStatusBranch: string | null;
  effectiveEnvMode: EnvMode;
  envLocked: boolean;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  onCheckoutPullRequestRequest?: ((reference: string) => void) | undefined;
}) {
  const {
    branches,
    branchQuery,
    branchStatusBranch,
    effectiveEnvMode,
    envLocked,
    activeWorktreePath,
    activeThreadBranch,
    onCheckoutPullRequestRequest,
  } = input;
  const trimmedBranchQuery = branchQuery.trim();
  const currentGitBranch =
    branchStatusBranch ?? branches.find((branch) => branch.current)?.name ?? null;
  const canonicalActiveBranch = resolveBranchToolbarValue({
    envMode: effectiveEnvMode,
    activeWorktreePath,
    activeThreadBranch,
    currentGitBranch,
  });
  const branchNames = branches.map((branch) => branch.name);
  const branchByName = new Map(branches.map((branch) => [branch.name, branch] as const));
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
  const branchPickerItems = [...branchNames];
  if (createBranchItemValue && !hasExactBranchMatch) {
    branchPickerItems.push(createBranchItemValue);
  }
  if (checkoutPullRequestItemValue) {
    branchPickerItems.unshift(checkoutPullRequestItemValue);
  }
  const filteredBranchPickerItems =
    normalizedBranchQuery.length === 0
      ? branchPickerItems
      : branchPickerItems.filter((itemValue) =>
          shouldIncludeBranchPickerItem({
            itemValue,
            normalizedQuery: normalizedBranchQuery,
            createBranchItemValue,
            checkoutPullRequestItemValue,
          }),
        );

  return {
    trimmedBranchQuery,
    currentGitBranch,
    canonicalActiveBranch,
    branchByName,
    prReference,
    isSelectingWorktreeBase,
    checkoutPullRequestItemValue,
    createBranchItemValue,
    filteredBranchPickerItems,
    branchPickerItems,
  };
}

export function deriveSelectedBranchName(branch: GitBranch): string {
  return branch.isRemote ? deriveLocalBranchNameFromRemoteRef(branch.name) : branch.name;
}

export { resolveBranchSelectionTarget };
