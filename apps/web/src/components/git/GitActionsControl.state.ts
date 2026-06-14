import type { GitRunStackedActionResult, GitStatusResult } from "@bigbud/contracts";
import { isTemporaryWorktreeBranch } from "@bigbud/shared/git";
import type {
  DefaultBranchActionDialogCopy,
  DefaultBranchConfirmableAction,
  GitActionMenuItem,
} from "./GitActionsControl.logic";

export type { DefaultBranchActionDialogCopy } from "./GitActionsControl.logic";

export function resolveDefaultBranchActionDialogCopy(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
}): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;
  const suffix = ` on "${branchLabel}". You can continue on this branch or create a feature branch and run the same action there.`;

  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return {
        title: "Commit & push to default branch?",
        description: `This action will commit and push changes${suffix}`,
        continueLabel: `Commit & push to ${branchLabel}`,
      };
    }
    return {
      title: "Push to default branch?",
      description: `This action will push local commits${suffix}`,
      continueLabel: `Push to ${branchLabel}`,
    };
  }

  if (input.includesCommit) {
    return {
      title: "Commit, push & create PR from default branch?",
      description: `This action will commit, push, and create a PR${suffix}`,
      continueLabel: "Commit, push & create PR",
    };
  }
  return {
    title: "Push & create PR from default branch?",
    description: `This action will push local commits and create a PR${suffix}`,
    continueLabel: "Push & create PR",
  };
}

export function resolveThreadBranchUpdate(
  result: GitRunStackedActionResult,
): { branch: string } | null {
  if (result.branch.status !== "created" || !result.branch.name) {
    return null;
  }

  return {
    branch: result.branch.name,
  };
}

export function resolveLiveThreadBranchUpdate(input: {
  threadBranch: string | null;
  gitStatus: GitStatusResult | null;
}): { branch: string | null } | null {
  if (!input.gitStatus) {
    return null;
  }

  if (input.gitStatus.branch === null && input.threadBranch !== null) {
    return null;
  }

  if (input.threadBranch === input.gitStatus.branch) {
    return null;
  }

  if (
    input.threadBranch !== null &&
    input.gitStatus.branch !== null &&
    !isTemporaryWorktreeBranch(input.threadBranch) &&
    isTemporaryWorktreeBranch(input.gitStatus.branch)
  ) {
    return null;
  }

  return {
    branch: input.gitStatus.branch,
  };
}

export function getMenuActionDisabledReason({
  item,
  gitStatus,
  isBusy,
  hasOriginRemote,
}: {
  item: GitActionMenuItem;
  gitStatus: GitStatusResult | null;
  isBusy: boolean;
  hasOriginRemote: boolean;
}): string | null {
  if (!item.disabled) return null;
  if (isBusy) return "Git action in progress.";
  if (!gitStatus) return "Git status is unavailable.";

  const hasBranch = gitStatus.branch !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;

  if (item.id === "initialize_git") {
    return "Initializing Git...";
  }

  if (item.id === "commit") {
    return hasChanges
      ? "Commit is currently unavailable."
      : "Worktree is clean. Make changes before committing.";
  }

  if (item.id === "push") {
    if (!hasBranch) return "Detached HEAD: checkout a branch before pushing.";
    if (hasChanges) return "Commit or stash local changes before pushing.";
    if (isBehind) return "Branch is behind upstream. Pull/rebase before pushing.";
    if (!gitStatus.hasUpstream && !hasOriginRemote) return 'Add an "origin" remote before pushing.';
    if (!isAhead) return "No local commits to push.";
    return "Push is currently unavailable.";
  }

  if (item.id === "pull") {
    if (!hasBranch) return "Detached HEAD: checkout a branch before pulling.";
    if (hasChanges) return "Commit or stash local changes before pulling.";
    if (!isBehind) return "Branch is up to date. Nothing to pull.";
    if (!gitStatus.hasUpstream && !hasOriginRemote) return 'Add an "origin" remote before pulling.';
    return "Pull is currently unavailable.";
  }

  if (item.id === "fetch") {
    if (!hasOriginRemote) return 'Add an "origin" remote before fetching.';
    return "Fetch is currently unavailable.";
  }

  if (item.id === "discard_changes") {
    return hasChanges
      ? "Discard changes is currently unavailable."
      : "Worktree is clean. Nothing to discard.";
  }

  return null;
}
