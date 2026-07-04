import { Pencil, Plus, SquareSplitHorizontal, Trash2 } from "lucide-react";
import { TerminalActionButton } from "./TerminalActionButton";

interface ThreadTerminalDrawerFloatingActionsProps {
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
}

export function ThreadTerminalDrawerFloatingActions({
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
}: ThreadTerminalDrawerFloatingActionsProps) {
  return (
    <div className="pointer-events-none absolute right-2 top-2 z-20">
      <div className="pointer-events-auto inline-flex items-center overflow-hidden rounded-md border border-border/80 bg-background/70">
        <TerminalActionButton
          className="p-1 text-foreground/90 transition-colors hover:bg-accent"
          onClick={onRenameTerminalAction}
          label={renameTerminalActionLabel}
        >
          <Pencil className="size-3.25" />
        </TerminalActionButton>
        <div className="h-4 w-px bg-border/80" />
        <TerminalActionButton
          className={`p-1 text-foreground/90 transition-colors ${
            hasReachedSplitLimit
              ? "cursor-not-allowed opacity-45 hover:bg-transparent"
              : "hover:bg-accent"
          }`}
          onClick={onSplitTerminalAction}
          label={splitTerminalActionLabel}
        >
          <SquareSplitHorizontal className="size-3.25" />
        </TerminalActionButton>
        <div className="h-4 w-px bg-border/80" />
        <TerminalActionButton
          className="p-1 text-foreground/90 transition-colors hover:bg-accent"
          onClick={onNewTerminalAction}
          label={newTerminalActionLabel}
        >
          <Plus className="size-3.25" />
        </TerminalActionButton>
        <div className="h-4 w-px bg-border/80" />
        <TerminalActionButton
          className="p-1 text-foreground/90 transition-colors hover:bg-accent"
          onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
          label={closeTerminalActionLabel}
        >
          <Trash2 className="size-3.25" />
        </TerminalActionButton>
      </div>
    </div>
  );
}
