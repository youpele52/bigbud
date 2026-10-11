import { Maximize2, Minimize2, Pencil, Plus, SquareSplitHorizontal, Trash2 } from "lucide-react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TerminalActionButton } from "./TerminalActionButton";

export interface ThreadTerminalDrawerToolbarProps {
  hasReachedSplitLimit: boolean;
  renameTerminalActionLabel: string;
  splitTerminalActionLabel: string;
  newTerminalActionLabel: string;
  closeTerminalActionLabel: string;
  resolvedActiveTerminalId: string;
  onRenameTerminalAction: () => void;
  onSplitTerminalAction: () => void;
  onNewTerminalAction: () => void;
  onCloseTerminal: (terminalId: string) => void;
  expanded?: boolean;
  onToggleExpanded?: (() => void) | undefined;
  variant?: "floating" | "sidebar";
}

/** Shared action strip for the single-terminal and multi-terminal drawer layouts. */
export function ThreadTerminalDrawerToolbar({
  hasReachedSplitLimit,
  renameTerminalActionLabel,
  splitTerminalActionLabel,
  newTerminalActionLabel,
  closeTerminalActionLabel,
  resolvedActiveTerminalId,
  onRenameTerminalAction,
  onSplitTerminalAction,
  onNewTerminalAction,
  onCloseTerminal,
  expanded = false,
  onToggleExpanded,
  variant = "floating",
}: ThreadTerminalDrawerToolbarProps) {
  const sidebar = variant === "sidebar";
  const buttonClassName = cn(
    "inline-flex items-center transition-colors",
    sidebar ? "h-full px-1 hover:bg-accent/70" : "p-1 hover:bg-accent",
    "text-muted-foreground hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
  );
  const expansionLabel = expanded ? "Restore split view" : "Expand terminal";

  return (
    <div className={cn("inline-flex items-center", sidebar && "h-full")}>
      <TerminalActionButton
        className={buttonClassName}
        onClick={onNewTerminalAction}
        label={newTerminalActionLabel}
      >
        <Plus className="size-3.25" />
      </TerminalActionButton>
      <TerminalActionButton
        className={cn(
          buttonClassName,
          hasReachedSplitLimit && "cursor-not-allowed opacity-45 hover:bg-transparent",
        )}
        onClick={onSplitTerminalAction}
        label={splitTerminalActionLabel}
      >
        <SquareSplitHorizontal className="size-3.25" />
      </TerminalActionButton>
      {onToggleExpanded && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={buttonClassName}
                onClick={onToggleExpanded}
                aria-label={expansionLabel}
              />
            }
          >
            {expanded ? <Minimize2 className="size-3.25" /> : <Maximize2 className="size-3.25" />}
          </TooltipTrigger>
          <TooltipPopup
            side="bottom"
            className="pointer-events-none"
            positionerClassName="pointer-events-none"
          >
            {expansionLabel}
          </TooltipPopup>
        </Tooltip>
      )}
      <TerminalActionButton
        className={buttonClassName}
        onClick={onRenameTerminalAction}
        label={renameTerminalActionLabel}
      >
        <Pencil className="size-3.25" />
      </TerminalActionButton>
      <div className={sidebar ? "h-full w-px bg-border/70" : "h-4 w-px bg-border/80"} />
      <TerminalActionButton
        className={buttonClassName}
        onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
        label={closeTerminalActionLabel}
      >
        <Trash2 className="size-3.25" />
      </TerminalActionButton>
    </div>
  );
}
