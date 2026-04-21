import { Plus, SquareSplitHorizontal, TerminalSquare, Trash2, XIcon } from "lucide-react";

import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";

import { type ThreadTerminalGroup } from "../../models/types";
import { TerminalActionButton } from "./TerminalActionButton";

interface ThreadTerminalDrawerSidebarProps {
  resolvedTerminalGroups: ReadonlyArray<ThreadTerminalGroup>;
  resolvedActiveTerminalId: string;
  normalizedTerminalIds: ReadonlyArray<string>;
  terminalLabelById: ReadonlyMap<string, string>;
  showGroupHeaders: boolean;
  hasReachedSplitLimit: boolean;
  splitTerminalActionLabel: string;
  newTerminalActionLabel: string;
  closeTerminalActionLabel: string;
  closeShortcutLabel?: string | undefined;
  onSplitTerminalAction: () => void;
  onNewTerminalAction: () => void;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
}

export function ThreadTerminalDrawerSidebar({
  resolvedTerminalGroups,
  resolvedActiveTerminalId,
  normalizedTerminalIds,
  terminalLabelById,
  showGroupHeaders,
  hasReachedSplitLimit,
  splitTerminalActionLabel,
  newTerminalActionLabel,
  closeTerminalActionLabel,
  closeShortcutLabel,
  onSplitTerminalAction,
  onNewTerminalAction,
  onActiveTerminalChange,
  onCloseTerminal,
}: ThreadTerminalDrawerSidebarProps) {
  return (
    <aside className="flex w-36 min-w-36 flex-col border border-border/70 bg-muted/10">
      <div className="flex h-[22px] items-stretch justify-end border-b border-border/70">
        <div className="inline-flex h-full items-stretch">
          <TerminalActionButton
            className={`inline-flex h-full items-center px-1 text-foreground/90 transition-colors ${
              hasReachedSplitLimit
                ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                : "hover:bg-accent/70"
            }`}
            onClick={onSplitTerminalAction}
            label={splitTerminalActionLabel}
          >
            <SquareSplitHorizontal className="size-3.25" />
          </TerminalActionButton>
          <TerminalActionButton
            className="inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors hover:bg-accent/70"
            onClick={onNewTerminalAction}
            label={newTerminalActionLabel}
          >
            <Plus className="size-3.25" />
          </TerminalActionButton>
          <TerminalActionButton
            className="inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors hover:bg-accent/70"
            onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
            label={closeTerminalActionLabel}
          >
            <Trash2 className="size-3.25" />
          </TerminalActionButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {resolvedTerminalGroups.map((terminalGroup, groupIndex) => {
          const isGroupActive = terminalGroup.terminalIds.includes(resolvedActiveTerminalId);
          const groupActiveTerminalId = isGroupActive
            ? resolvedActiveTerminalId
            : (terminalGroup.terminalIds[0] ?? resolvedActiveTerminalId);

          return (
            <div key={terminalGroup.id} className="pb-0.5">
              {showGroupHeaders && (
                <button
                  type="button"
                  className={`flex w-full items-center rounded px-1 py-0.5 text-[10px] uppercase tracking-[0.08em] ${
                    isGroupActive
                      ? "bg-accent/70 text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  }`}
                  onClick={() => onActiveTerminalChange(groupActiveTerminalId)}
                >
                  {terminalGroup.terminalIds.length > 1
                    ? `Split ${groupIndex + 1}`
                    : `Terminal ${groupIndex + 1}`}
                </button>
              )}

              <div className={showGroupHeaders ? "ml-1 border-l border-border/60 pl-1.5" : ""}>
                {terminalGroup.terminalIds.map((terminalId) => {
                  const isActive = terminalId === resolvedActiveTerminalId;
                  const closeTerminalLabel = `Close ${
                    terminalLabelById.get(terminalId) ?? "terminal"
                  }${isActive && closeShortcutLabel ? ` (${closeShortcutLabel})` : ""}`;

                  return (
                    <div
                      key={terminalId}
                      className={`group flex items-center gap-1 rounded px-1 py-0.5 text-[11px] ${
                        isActive
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      }`}
                    >
                      {showGroupHeaders && (
                        <span className="text-[10px] text-muted-foreground/80">└</span>
                      )}
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-1 text-left"
                        onClick={() => onActiveTerminalChange(terminalId)}
                      >
                        <TerminalSquare className="size-3 shrink-0" />
                        <span className="truncate">
                          {terminalLabelById.get(terminalId) ?? "Terminal"}
                        </span>
                      </button>
                      {normalizedTerminalIds.length > 1 && (
                        <Popover>
                          <PopoverTrigger
                            openOnHover
                            render={
                              <button
                                type="button"
                                className="inline-flex size-3.5 items-center justify-center rounded text-xs font-medium leading-none text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100"
                                onClick={() => onCloseTerminal(terminalId)}
                                aria-label={closeTerminalLabel}
                              />
                            }
                          >
                            <XIcon className="size-2.5" />
                          </PopoverTrigger>
                          <PopoverPopup
                            tooltipStyle
                            side="bottom"
                            sideOffset={6}
                            align="center"
                            className="pointer-events-none select-none"
                          >
                            {closeTerminalLabel}
                          </PopoverPopup>
                        </Popover>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
