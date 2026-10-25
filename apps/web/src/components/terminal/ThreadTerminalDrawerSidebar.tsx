import { type ProviderKind, type ThreadId } from "@bigbud/contracts";
import { TerminalSquare, XIcon } from "lucide-react";

import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/provider/ProviderModelPicker.models";

import { type ThreadTerminalGroup } from "../../models/types";
import { ThreadTerminalDrawerToolbar } from "./ThreadTerminalDrawerToolbar";
import { ThreadTerminalDrawerRenameEditor } from "./ThreadTerminalDrawerRenameEditor";

interface ThreadTerminalDrawerSidebarProps {
  threadId?: ThreadId;
  resolvedTerminalGroups: ReadonlyArray<ThreadTerminalGroup>;
  resolvedActiveTerminalId: string;
  normalizedTerminalIds: ReadonlyArray<string>;
  terminalLabelById: ReadonlyMap<string, string>;
  editingTerminalId: string | null;
  terminalRenameDraft: string;
  renameInputRef: (element: HTMLInputElement | null) => void;
  terminalProviderById: Readonly<Record<string, ProviderKind>>;
  showGroupHeaders: boolean;
  hasReachedSplitLimit: boolean;
  renameTerminalActionLabel: string;
  splitTerminalActionLabel: string;
  newTerminalActionLabel: string;
  closeTerminalActionLabel: string;
  closeShortcutLabel?: string | undefined;
  onTerminalRenameDraftChange: (value: string) => void;
  onStartTerminalRename: (terminalId: string) => void;
  onCommitTerminalRename: () => void;
  onCancelTerminalRename: () => void;
  onResetTerminalRename: (terminalId: string) => void;
  onSplitTerminalAction: () => void;
  onNewTerminalAction: () => void;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  expanded?: boolean;
  onToggleExpanded?: (() => void) | undefined;
}

export function ThreadTerminalDrawerSidebar({
  threadId,
  resolvedTerminalGroups,
  resolvedActiveTerminalId,
  normalizedTerminalIds,
  terminalLabelById,
  editingTerminalId,
  terminalRenameDraft,
  renameInputRef,
  terminalProviderById,
  showGroupHeaders,
  hasReachedSplitLimit,
  renameTerminalActionLabel,
  splitTerminalActionLabel,
  newTerminalActionLabel,
  closeTerminalActionLabel,
  closeShortcutLabel,
  onTerminalRenameDraftChange,
  onStartTerminalRename,
  onCommitTerminalRename,
  onCancelTerminalRename,
  onResetTerminalRename,
  onSplitTerminalAction,
  onNewTerminalAction,
  onActiveTerminalChange,
  onCloseTerminal,
  expanded = false,
  onToggleExpanded,
}: ThreadTerminalDrawerSidebarProps) {
  return (
    <aside className="flex w-36 min-w-36 flex-col border border-border/70 bg-muted/10">
      <div className="flex h-[22px] items-stretch justify-end border-b border-border/70">
        <ThreadTerminalDrawerToolbar
          threadId={threadId}
          variant="sidebar"
          hasReachedSplitLimit={hasReachedSplitLimit}
          renameTerminalActionLabel={renameTerminalActionLabel}
          splitTerminalActionLabel={splitTerminalActionLabel}
          newTerminalActionLabel={newTerminalActionLabel}
          closeTerminalActionLabel={closeTerminalActionLabel}
          resolvedActiveTerminalId={resolvedActiveTerminalId}
          onRenameTerminalAction={() => onStartTerminalRename(resolvedActiveTerminalId)}
          onSplitTerminalAction={onSplitTerminalAction}
          onNewTerminalAction={onNewTerminalAction}
          onCloseTerminal={onCloseTerminal}
          expanded={expanded}
          onToggleExpanded={onToggleExpanded}
        />
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
                  const terminalProvider = terminalProviderById[terminalId] ?? null;
                  const ProviderIcon = terminalProvider
                    ? PROVIDER_ICON_BY_PROVIDER[terminalProvider]
                    : null;
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
                      {editingTerminalId === terminalId ? (
                        <ThreadTerminalDrawerRenameEditor
                          value={terminalRenameDraft}
                          placeholder={terminalLabelById.get(terminalId) ?? "Terminal"}
                          onChange={onTerminalRenameDraftChange}
                          onCommit={onCommitTerminalRename}
                          onCancel={onCancelTerminalRename}
                          onReset={() => onResetTerminalRename(terminalId)}
                          autoFocus
                          inputRef={renameInputRef}
                          className="min-w-0 flex-1"
                        />
                      ) : (
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-1 text-left"
                          onClick={() => onActiveTerminalChange(terminalId)}
                          onDoubleClick={() => onStartTerminalRename(terminalId)}
                        >
                          {ProviderIcon ? (
                            <ProviderIcon className="size-3 shrink-0" />
                          ) : (
                            <TerminalSquare className="size-3 shrink-0" />
                          )}
                          <span className="truncate">
                            {terminalLabelById.get(terminalId) ?? "Terminal"}
                          </span>
                        </button>
                      )}
                      {editingTerminalId !== terminalId && normalizedTerminalIds.length > 1 && (
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
