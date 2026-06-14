import type { GitStackedAction, GitStatusResult } from "@bigbud/contracts";
export type GitActionIconName =
  | "commit"
  | "push"
  | "pull"
  | "fetch"
  | "view_git_panel"
  | "view_history"
  | "discard_changes"
  | "initialize_git";

export type GitMenuItemId =
  | "initialize_git"
  | "commit"
  | "push"
  | "pull"
  | "fetch"
  | "view_git_panel"
  | "view_history"
  | "discard_changes";

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
  id: GitMenuItemId;
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog" | "run_action" | "open_panel";
  dialogAction?: GitDialogAction;
  panelAction?: "changes" | "history";
  action?: GitStackedAction | "pull" | "fetch" | "discard" | "initialize_git";
  variant?: "destructive";
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

  const isRepo = gitStatus.isRepo ?? true;
  if (!isRepo) {
    return [
      {
        id: "initialize_git",
        label: "Initialize Git",
        disabled: isBusy,
        icon: "initialize_git",
        kind: "run_action",
        action: "initialize_git",
      },
    ];
  }

  const hasBranch = gitStatus.branch !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const isBehind = gitStatus.behindCount > 0;
  const isAhead = gitStatus.aheadCount > 0;
  const canPushWithoutUpstream = hasOriginRemote && !gitStatus.hasUpstream;
  const canCommit = !isBusy && hasChanges;
  const canPush =
    !isBusy &&
    hasBranch &&
    !hasChanges &&
    !isBehind &&
    isAhead &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canPull = !isBusy && hasBranch && !hasChanges && isBehind;
  const canFetch = !isBusy && hasOriginRemote;
  const canDiscard = !isBusy && hasChanges;

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
      kind: "run_action",
      action: "push",
    },
    {
      id: "pull",
      label: "Pull",
      disabled: !canPull,
      icon: "pull",
      kind: "run_action",
      action: "pull",
    },
    {
      id: "fetch",
      label: "Fetch",
      disabled: !canFetch,
      icon: "fetch",
      kind: "run_action",
      action: "fetch",
    },
    {
      id: "view_git_panel",
      label: "View changes",
      disabled: false,
      icon: "view_git_panel",
      kind: "open_panel",
      panelAction: "changes",
    },
    {
      id: "view_history",
      label: "View history",
      disabled: false,
      icon: "view_history",
      kind: "open_panel",
      panelAction: "history",
    },
    {
      id: "discard_changes",
      label: "Discard changes",
      disabled: !canDiscard,
      icon: "discard_changes",
      kind: "run_action",
      action: "discard",
      variant: "destructive",
    },
  ];
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
