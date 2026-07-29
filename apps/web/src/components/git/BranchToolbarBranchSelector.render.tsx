import type { GitBranch } from "@bigbud/contracts";
import type { RefObject } from "react";

import { MenuItem, MenuPopup, MenuSub, MenuSubPopup, MenuSubTrigger } from "../ui/menu";
import { Searchbar } from "../ui/Searchbar";
import { BranchToolbarBranchActions } from "./BranchToolbarBranchActions";

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

export function BranchToolbarBranchSelectorPopup(props: {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  branchStatusText: string | null;
  itemValues: string[];
  checkoutPullRequestItemValue: string | null;
  createBranchItemValue: string | null;
  prReference: string | null;
  trimmedBranchQuery: string;
  branchByName: Map<string, GitBranch>;
  activeProjectCwd: string | null;
  isSelectingWorktreeBase: boolean;
  actionPending: boolean;
  onQueryChange: (query: string) => void;
  onSelect: (branch: GitBranch) => void;
  onCheckoutPullRequest: () => void;
  onCreateBranch: () => void;
  onRenameRequest: (branch: GitBranch) => void;
  onDeleteRequest: (branch: GitBranch) => void;
}) {
  return (
    <MenuPopup align="end" side="top" className="w-80 !p-0 overflow-hidden">
      <Searchbar
        sticky
        showSearchIcon={false}
        canClear={props.query.length > 0}
        onClear={() => {
          props.onQueryChange("");
          props.inputRef.current?.focus();
        }}
        onClick={() => props.inputRef.current?.focus()}
      >
        <input
          ref={props.inputRef}
          type="text"
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
          placeholder="Search branches"
          className="min-w-0 flex-1 bg-transparent py-0.5 text-xs tracking-tight text-foreground placeholder:text-xs placeholder:tracking-tight placeholder:text-muted-foreground/50 focus:outline-none"
        />
      </Searchbar>
      <div className="max-h-56 overflow-y-auto p-1">
        {props.itemValues.length === 0 ? (
          <div className="px-3 py-4 text-center text-sm text-muted-foreground/60">
            No branches found.
          </div>
        ) : (
          <BranchToolbarBranchSelectorItems {...props} />
        )}
      </div>
      {props.branchStatusText ? (
        <div className="border-t px-3 py-2 text-xs text-muted-foreground">
          {props.branchStatusText}
        </div>
      ) : null}
    </MenuPopup>
  );
}
