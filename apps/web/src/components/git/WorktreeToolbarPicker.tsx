import { useState } from "react";
import { ChevronDownIcon, CheckIcon } from "lucide-react";
import type { WorktreeEntry, WorktreeInventory } from "@bigbud/contracts/workspace/worktrees.ts";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
  MenuSeparator,
} from "../ui/menu";
import { Button } from "../ui/button";
import { WorktreeIcon } from "./WorktreeIcon";
import { WorktreeToolbarActions } from "./WorktreeToolbar.actions";

export function WorktreeToolbarPicker(props: {
  inventory: WorktreeInventory | undefined;
  selectedPath: string | null;
  disabled: boolean;
  createDisabled?: boolean;
  error?: string;
  onRefresh: () => void;
  onCreate: () => void;
  onOperations?: () => void;
  onSelect: (entry: WorktreeEntry) => void;
  onDelete: (entry: WorktreeEntry) => void;
}) {
  const [query, setQuery] = useState("");
  if (!props.inventory?.linkedCount) return null;
  const selected = props.inventory.entries.find((entry) => entry.path === props.selectedPath);
  const label = selected
    ? selected.main
      ? "Main checkout"
      : selected.name
    : "Worktree unavailable";
  return (
    <Menu
      onOpenChange={(open) => {
        if (open) props.onRefresh();
        else setQuery("");
      }}
    >
      <MenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="max-w-full min-w-0 text-muted-foreground/70"
          />
        }
        aria-label={`Worktree: ${label}`}
        aria-description={selected?.path ?? props.selectedPath ?? undefined}
        title={selected?.path ?? props.selectedPath ?? "Worktree unavailable"}
      >
        <WorktreeIcon />
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon className="size-3 shrink-0" />
      </MenuTrigger>
      <MenuPopup side="top" align="center" className="w-80 max-w-[calc(100vw-2rem)]">
        {props.error && (
          <p role="alert" className="px-3 py-2 text-xs text-destructive">
            Could not refresh worktrees. Actions will revalidate their target.
          </p>
        )}
        <input
          aria-label="Search worktrees"
          placeholder="Search worktrees"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
          className="mb-1 w-full border-b bg-transparent px-2 py-2 text-xs tracking-tight placeholder:text-xs placeholder:tracking-tight placeholder:text-muted-foreground/50 outline-none"
        />
        <div className="max-h-64 overflow-y-auto">
          {props.inventory.entries
            .filter((entry) =>
              `${entry.name} ${entry.path} ${entry.branch ?? ""}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((entry) => (
              <MenuSub key={entry.path}>
                <MenuSubTrigger title={entry.path}>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{entry.main ? "Main checkout" : entry.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {entry.branch ?? (entry.bare ? "Bare repository" : "Detached HEAD")}
                    </span>
                  </span>
                  {entry.path === props.selectedPath && <CheckIcon className="size-3" />}
                </MenuSubTrigger>
                <MenuSubPopup className="w-64">
                  <div className="break-all px-3 py-2 text-xs text-muted-foreground">
                    {entry.path}
                  </div>
                  <WorktreeToolbarActions
                    entry={entry}
                    local={props.inventory!.local}
                    disabled={props.disabled}
                    onSelect={() => props.onSelect(entry)}
                    onDelete={() => props.onDelete(entry)}
                  />
                </MenuSubPopup>
              </MenuSub>
            ))}
        </div>
        <MenuSeparator />
        <MenuItem
          disabled={props.createDisabled || !props.inventory.local}
          onClick={props.onCreate}
        >
          Create worktree…
        </MenuItem>
        {props.inventory.local && props.onOperations && (
          <MenuItem onClick={props.onOperations}>Worktree operations…</MenuItem>
        )}
      </MenuPopup>
    </Menu>
  );
}
