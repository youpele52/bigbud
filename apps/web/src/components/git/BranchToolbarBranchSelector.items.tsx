import type { GitBranch } from "@bigbud/contracts";
import { MenuItem, MenuSub, MenuSubPopup, MenuSubTrigger } from "../ui/menu";
import { BranchToolbarBranchActions } from "./BranchToolbarBranchActions";
import { WorktreeIcon } from "./WorktreeIcon";

export function BranchToolbarBranchSelectorItems(props: {
  itemValues: string[];
  checkoutPullRequestItemValue: string | null;
  createBranchItemValue: string | null;
  prReference: string | null;
  trimmedBranchQuery: string;
  branchByName: Map<string, GitBranch>;
  activeProjectCwd: string | null;
  isSelectingWorktreeBase: boolean;
  actionPending: boolean;
  onSelect: (branch: GitBranch) => void;
  onCheckoutPullRequest: () => void;
  onCreateBranch: () => void;
  onRenameRequest: (branch: GitBranch) => void;
  onDeleteRequest: (branch: GitBranch) => void;
}) {
  return props.itemValues.map((itemValue) => {
    if (props.checkoutPullRequestItemValue && itemValue === props.checkoutPullRequestItemValue) {
      return (
        <MenuItem key={itemValue} onClick={props.onCheckoutPullRequest}>
          <div className="flex min-w-0 flex-col items-start py-1">
            <span className="truncate font-medium">Checkout Pull Request</span>
            <span className="truncate text-xs text-muted-foreground">{props.prReference}</span>
          </div>
        </MenuItem>
      );
    }
    if (props.createBranchItemValue && itemValue === props.createBranchItemValue) {
      return (
        <MenuItem key={itemValue} onClick={props.onCreateBranch}>
          <span className="truncate">Create new branch "{props.trimmedBranchQuery}"</span>
        </MenuItem>
      );
    }

    const branch = props.branchByName.get(itemValue);
    if (!branch) return null;
    const hasSecondaryWorktree =
      branch.worktreePath && branch.worktreePath !== props.activeProjectCwd;
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
      <MenuSub key={itemValue}>
        <MenuSubTrigger>
          <span className="truncate">{itemValue}</span>
          {hasSecondaryWorktree && <WorktreeIcon />}
          {badge ? <span className="text-[10px] text-muted-foreground/45">{badge}</span> : null}
        </MenuSubTrigger>
        <MenuSubPopup sideOffset={4} className="w-56">
          <BranchToolbarBranchActions
            branch={branch}
            disabled={props.actionPending}
            selectLabel={props.isSelectingWorktreeBase ? "Select base branch" : "Checkout"}
            onSelect={props.onSelect}
            onRenameRequest={props.onRenameRequest}
            onDeleteRequest={props.onDeleteRequest}
          />
        </MenuSubPopup>
      </MenuSub>
    );
  });
}
