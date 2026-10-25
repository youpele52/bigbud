import type { ComponentProps, RefObject } from "react";
import { MenuItem, MenuPopup } from "../ui/menu";
import { Searchbar } from "../ui/Searchbar";
import { BranchToolbarBranchSelectorItems } from "./BranchToolbarBranchSelector.items";
import { WorktreeIcon } from "./WorktreeIcon";

export function BranchToolbarBranchSelectorPopup(
  props: ComponentProps<typeof BranchToolbarBranchSelectorItems> & {
    executionTargetId?: string | undefined;
    onCreateWorktreeRequest?: () => void;
    onWorktreeOperationsRequest?: () => void;
    inputRef: RefObject<HTMLInputElement | null>;
    query: string;
    branchStatusText: string | null;
    onQueryChange: (query: string) => void;
  },
) {
  const remote = !!props.executionTargetId && props.executionTargetId !== "local";
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
      {props.branchStatusText && (
        <div className="border-t px-3 py-2 text-xs text-muted-foreground">
          {props.branchStatusText}
        </div>
      )}
      {props.onCreateWorktreeRequest && (
        <>
          <MenuItem disabled={remote} onClick={props.onCreateWorktreeRequest}>
            <WorktreeIcon />
            Create worktree…
          </MenuItem>
          {remote && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              Explicit worktree creation is local-only. Use the existing remote worktree workflow.
            </p>
          )}
        </>
      )}
      {props.onWorktreeOperationsRequest && (
        <MenuItem onClick={props.onWorktreeOperationsRequest}>
          <WorktreeIcon />
          Worktree operations…
        </MenuItem>
      )}
    </MenuPopup>
  );
}
