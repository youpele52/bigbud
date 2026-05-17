import type { CSSProperties } from "react";
import type { GitBranch } from "@bigbud/contracts";
import { ComboboxItem } from "../ui/combobox";

interface RenderBranchPickerItemInput {
  itemValue: string;
  index: number;
  style?: CSSProperties;
  checkoutPullRequestItemValue: string | null;
  createBranchItemValue: string | null;
  prReference: string | null;
  trimmedBranchQuery: string;
  branchByName: Map<string, GitBranch>;
  activeProjectCwd: string | null;
}

export function renderBranchPickerItem({
  itemValue,
  index,
  style,
  checkoutPullRequestItemValue,
  createBranchItemValue,
  prReference,
  trimmedBranchQuery,
  branchByName,
  activeProjectCwd,
}: RenderBranchPickerItemInput) {
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
