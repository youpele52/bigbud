import type { GitStackedAction, GitStatusResult } from "@bigbud/contracts";
export type GitActionIconName = "commit" | "push" | "pr";

const GIT_DIALOG_ACTIONS = {
  commit: "commit",
  push: "push",
  createPr: "create_pr",
} as const;

export type GitDialogAction = (typeof GIT_DIALOG_ACTIONS)[keyof typeof GIT_DIALOG_ACTIONS];

const DEFAULT_BRANCH_CONFIRMABLE_ACTIONS = {
  push: GIT_DIALOG_ACTIONS.push,
  createPr: GIT_DIALOG_ACTIONS.createPr,
  commitPush: "commit_push",
  commitPushPr: "commit_push_pr",
} as const;

export interface GitActionMenuItem {
  id: "commit" | "push" | "pr";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog" | "open_pr";
  dialogAction?: GitDialogAction;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "open_pr" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

export interface DefaultBranchActionDialogCopy {
  title: string;
  description: string;
  continueLabel: string;
}

export type DefaultBranchConfirmableAction =
  (typeof DEFAULT_BRANCH_CONFIRMABLE_ACTIONS)[keyof typeof DEFAULT_BRANCH_CONFIRMABLE_ACTIONS];

export function buildGitActionProgressStages(input: {
  action: GitStackedAction;
  hasCustomCommitMessage: boolean;
  hasWorkingTreeChanges: boolean;
  pushTarget?: string;
  featureBranch?: boolean;
  shouldPushBeforePr?: boolean;
}): string[] {
  const branchStages = input.featureBranch ? ["Preparing feature branch..."] : [];
  const pushStage = input.pushTarget ? `Pushing to ${input.pushTarget}...` : "Pushing...";
  const prStages = [
    "Preparing PR...",
    "Generating PR content...",
    "Creating GitHub pull request...",
  ];

  if (input.action === GIT_DIALOG_ACTIONS.push) {
    return [pushStage];
  }
  if (input.action === GIT_DIALOG_ACTIONS.createPr) {
    return input.shouldPushBeforePr ? [pushStage, ...prStages] : prStages;
  }

  const shouldIncludeCommitStages =
    input.action === GIT_DIALOG_ACTIONS.commit || input.hasWorkingTreeChanges;
  const commitStages = !shouldIncludeCommitStages
    ? []
    : input.hasCustomCommitMessage
      ? ["Committing..."]
      : ["Generating commit message...", "Committing..."];
  if (input.action === GIT_DIALOG_ACTIONS.commit) {
    return [...branchStages, ...commitStages];
  }
  if (input.action === DEFAULT_BRANCH_CONFIRMABLE_ACTIONS.commitPush) {
    return [...branchStages, ...commitStages, pushStage];
  }
  return [...branchStages, ...commitStages, pushStage, ...prStages];
}

export function buildMenuItems(
  gitStatus: GitStatusResult | null,
  isBusy: boolean,
  hasOriginRemote = true,
): GitActionMenuItem[] {
  if (!gitStatus) return [];

  const hasBranch = gitStatus.branch !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isBehind = gitStatus.behindCount > 0;
  const canPushWithoutUpstream = hasOriginRemote && !gitStatus.hasUpstream;
  const canCommit = !isBusy && hasChanges;
  const canPush =
    !isBusy &&
    hasBranch &&
    !hasChanges &&
    !isBehind &&
    gitStatus.aheadCount > 0 &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canCreatePr =
    !isBusy &&
    hasBranch &&
    !hasChanges &&
    !hasOpenPr &&
    gitStatus.aheadCount > 0 &&
    !isBehind &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canOpenPr = !isBusy && hasOpenPr;

  return [
    {
      id: "commit",
      label: "Commit",
      disabled: !canCommit,
      icon: "commit",
      kind: "open_dialog",
      dialogAction: GIT_DIALOG_ACTIONS.commit,
    },
    {
      id: "push",
      label: "Push",
      disabled: !canPush,
      icon: "push",
      kind: "open_dialog",
      dialogAction: GIT_DIALOG_ACTIONS.push,
    },
    hasOpenPr
      ? {
          id: "pr",
          label: "View PR",
          disabled: !canOpenPr,
          icon: "pr",
          kind: "open_pr",
        }
      : {
          id: "pr",
          label: "Create PR",
          disabled: !canCreatePr,
          icon: "pr",
          kind: "open_dialog",
          dialogAction: GIT_DIALOG_ACTIONS.createPr,
        },
  ];
}

export function resolveQuickAction(
  gitStatus: GitStatusResult | null,
  isBusy: boolean,
  isDefaultBranch = false,
  hasOriginRemote = true,
): GitQuickAction {
  if (isBusy) {
    return { label: "Commit", disabled: true, kind: "show_hint", hint: "Git action in progress." };
  }

  if (!gitStatus) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Git status is unavailable.",
    };
  }

  const hasBranch = gitStatus.branch !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const isDiverged = isAhead && isBehind;

  if (!hasBranch) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Create and checkout a branch before pushing or opening a PR.",
    };
  }

  if (hasChanges) {
    if (!gitStatus.hasUpstream && !hasOriginRemote) {
      return {
        label: "Commit",
        disabled: false,
        kind: "run_action",
        action: GIT_DIALOG_ACTIONS.commit,
      };
    }
    if (hasOpenPr || isDefaultBranch) {
      return {
        label: "Commit & Push",
        disabled: false,
        kind: "run_action",
        action: DEFAULT_BRANCH_CONFIRMABLE_ACTIONS.commitPush,
      };
    }
    return {
      label: "Commit, Push & PR",
      disabled: false,
      kind: "run_action",
      action: DEFAULT_BRANCH_CONFIRMABLE_ACTIONS.commitPushPr,
    };
  }

  if (!gitStatus.hasUpstream) {
    if (!hasOriginRemote) {
      if (hasOpenPr && !isAhead) {
        return { label: "View PR", disabled: false, kind: "open_pr" };
      }
      return {
        label: "Push",
        disabled: true,
        kind: "show_hint",
        hint: 'Add an "origin" remote before pushing or creating a PR.',
      };
    }
    if (!isAhead) {
      if (hasOpenPr) {
        return { label: "View PR", disabled: false, kind: "open_pr" };
      }
      return {
        label: "Push",
        disabled: true,
        kind: "show_hint",
        hint: "No local commits to push.",
      };
    }
    if (hasOpenPr || isDefaultBranch) {
      return {
        label: "Push",
        disabled: false,
        kind: "run_action",
        action: isDefaultBranch
          ? DEFAULT_BRANCH_CONFIRMABLE_ACTIONS.commitPush
          : GIT_DIALOG_ACTIONS.push,
      };
    }
    return {
      label: "Push & Create PR",
      disabled: false,
      kind: "run_action",
      action: GIT_DIALOG_ACTIONS.createPr,
    };
  }

  if (isDiverged) {
    return {
      label: "Sync branch",
      disabled: true,
      kind: "show_hint",
      hint: "Branch has diverged from upstream. Rebase/merge first.",
    };
  }

  if (isBehind) {
    return {
      label: "Pull",
      disabled: false,
      kind: "run_pull",
    };
  }

  if (isAhead) {
    if (hasOpenPr || isDefaultBranch) {
      return {
        label: "Push",
        disabled: false,
        kind: "run_action",
        action: isDefaultBranch
          ? DEFAULT_BRANCH_CONFIRMABLE_ACTIONS.commitPush
          : GIT_DIALOG_ACTIONS.push,
      };
    }
    return {
      label: "Push & create PR",
      disabled: false,
      kind: "run_action",
      action: GIT_DIALOG_ACTIONS.createPr,
    };
  }

  if (hasOpenPr && gitStatus.hasUpstream) {
    return { label: "View PR", disabled: false, kind: "open_pr" };
  }

  return {
    label: "Commit",
    disabled: true,
    kind: "show_hint",
    hint: "Branch is up to date. No action needed.",
  };
}

export function requiresDefaultBranchConfirmation(
  action: GitStackedAction,
  isDefaultBranch: boolean,
): boolean {
  if (!isDefaultBranch) return false;
  return (
    action === DEFAULT_BRANCH_CONFIRMABLE_ACTIONS.push ||
    action === DEFAULT_BRANCH_CONFIRMABLE_ACTIONS.createPr ||
    action === DEFAULT_BRANCH_CONFIRMABLE_ACTIONS.commitPush ||
    action === DEFAULT_BRANCH_CONFIRMABLE_ACTIONS.commitPushPr
  );
}

// Re-export from shared for backwards compatibility in this module's exports
export { resolveAutoFeatureBranchName } from "@bigbud/shared/git";
export {
  getMenuActionDisabledReason,
  resolveDefaultBranchActionDialogCopy,
  resolveLiveThreadBranchUpdate,
  resolveThreadBranchUpdate,
} from "./GitActionsControl.state";
