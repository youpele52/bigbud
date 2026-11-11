import { CollapseIcon, ExpandIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Minus, Plus, SquareSplitHorizontal, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TerminalActionButton } from "./TerminalActionButton";
import type { ThreadId } from "@bigbud/contracts";
import { TerminalTargetPicker } from "./TerminalTargetPicker";
import { TerminalProfilePicker } from "./TerminalProfilePicker";
import type { TerminalProfileLaunch } from "../../lib/terminalProfileLaunch";

export interface ThreadTerminalDrawerToolbarProps {
  threadId?: ThreadId | undefined;
  hasReachedSplitLimit: boolean;
  renameTerminalActionLabel: string;
  splitTerminalActionLabel: string;
  newTerminalActionLabel: string;
  findShortcutLabel?: string | undefined;
  closeTerminalActionLabel: string;
  resolvedActiveTerminalId: string;
  onRenameTerminalAction: () => void;
  onSplitTerminalAction: () => void;
  onNewTerminalAction: (profile?: TerminalProfileLaunch) => void;
  onCloseTerminal: (terminalId: string) => void;
  expanded?: boolean;
  onToggleExpanded?: (() => void) | undefined;
  onMinimize?: (() => void) | undefined;
  variant?: "floating" | "sidebar";
}

/** Shared action strip for the single-terminal and multi-terminal drawer layouts. */
export function ThreadTerminalDrawerToolbar({
  threadId,
  hasReachedSplitLimit,
  splitTerminalActionLabel,
  newTerminalActionLabel,
  findShortcutLabel,
  closeTerminalActionLabel,
  resolvedActiveTerminalId,
  onRenameTerminalAction,
  onSplitTerminalAction,
  onNewTerminalAction,
  onCloseTerminal,
  expanded = false,
  onToggleExpanded,
  onMinimize,
  variant = "floating",
}: ThreadTerminalDrawerToolbarProps) {
  const sidebar = variant === "sidebar";
  const buttonClassName = cn(
    "inline-flex items-center transition-colors",
    sidebar ? "h-full px-1 hover:bg-accent/70" : "p-1 hover:bg-accent",
    "text-muted-foreground hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
  );
  const expansionLabel = expanded ? "Restore split view" : "Expand terminal";
  const dividerClassName = sidebar ? "h-full w-px bg-border/70" : "h-4 w-px bg-border/80";

  return (
    <div className={cn("inline-flex items-center", sidebar && "h-full")}>
      {threadId && (
        <TerminalTargetPicker
          threadId={threadId}
          terminalId={resolvedActiveTerminalId}
          compact={sidebar}
        />
      )}
      <TerminalActionButton
        className={buttonClassName}
        onClick={() => onNewTerminalAction()}
        label={newTerminalActionLabel}
      >
        <Plus className="size-3.25" />
      </TerminalActionButton>
      {threadId && (
        <TerminalProfilePicker
          threadId={threadId}
          terminalId={resolvedActiveTerminalId}
          onNewTerminal={onNewTerminalAction}
          findShortcutLabel={findShortcutLabel}
          onRename={onRenameTerminalAction}
        />
      )}
      <div className={dividerClassName} />
      <TerminalActionButton
        className={cn(
          buttonClassName,
          hasReachedSplitLimit && "cursor-not-allowed opacity-45 hover:bg-transparent",
        )}
        onClick={() => onSplitTerminalAction()}
        label={splitTerminalActionLabel}
      >
        <SquareSplitHorizontal className="size-3.25" />
      </TerminalActionButton>
      <div className={dividerClassName} />
      <TerminalActionButton
        className={buttonClassName}
        onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
        label={closeTerminalActionLabel}
      >
        <XIcon className="size-3.25" />
      </TerminalActionButton>
      {(onMinimize || onToggleExpanded) && <div className={dividerClassName} />}
      {onMinimize && (
        <TerminalActionButton
          className={buttonClassName}
          onClick={onMinimize}
          label="Minimize terminal"
        >
          <Minus className="size-3.25" />
        </TerminalActionButton>
      )}
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
            {expanded ? (
              <HugeiconsIcon aria-hidden="true" icon={CollapseIcon} className="size-3.25" />
            ) : (
              <HugeiconsIcon aria-hidden="true" icon={ExpandIcon} className="size-3.25" />
            )}
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
    </div>
  );
}
