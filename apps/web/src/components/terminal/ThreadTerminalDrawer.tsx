import {
  type ExecutionTargetId,
  type ProviderKind,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@bigbud/contracts";
import { useCallback, useMemo, useRef, useState } from "react";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import {
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
} from "../../models/types";
import { ThreadTerminalDrawerSidebar } from "./ThreadTerminalDrawerSidebar";
import { ThreadTerminalDrawerFloatingActions } from "./ThreadTerminalDrawerFloatingActions";
import { ThreadTerminalDrawerRenameEditor } from "./ThreadTerminalDrawerRenameEditor";
import { useThreadTerminalDrawerResize } from "./ThreadTerminalDrawer.resize";
import { ThreadTerminalDrawerViewport } from "./ThreadTerminalDrawerViewport";
import { buildTerminalLabelMap } from "./terminalDisplay";

// Re-export pure utilities consumed by tests and other modules
export {
  resolveTerminalSelectionActionPosition,
  selectPendingTerminalEventEntries,
  selectTerminalEventEntriesAfterSnapshot,
  shouldHandleTerminalSelectionMouseUp,
  terminalSelectionActionDelayForClickCount,
} from "./ThreadTerminalDrawer.logic";

interface ThreadTerminalDrawerProps {
  threadId: ThreadId;
  executionTargetId?: ExecutionTargetId | undefined;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  visible?: boolean;
  height: number;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  focusRequestId: number;
  onSplitTerminal: () => void;
  onNewTerminal: () => void;
  splitShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onHeightChange: (height: number) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  keybindings: ResolvedKeybindingsConfig;
  terminalBaseLabel: string;
  terminalLabelOverrides: Readonly<Record<string, string>>;
  terminalProviderById: Readonly<Record<string, ProviderKind>>;
  mode?: "drawer" | "panel";
  onSetTerminalLabelOverride: (terminalId: string, label: string) => void;
  onClearTerminalLabelOverride: (terminalId: string) => void;
}

export default function ThreadTerminalDrawer({
  threadId,
  executionTargetId,
  cwd,
  worktreePath,
  runtimeEnv,
  visible = true,
  height,
  terminalIds,
  activeTerminalId,
  terminalGroups,
  activeTerminalGroupId,
  focusRequestId,
  onSplitTerminal,
  onNewTerminal,
  splitShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  onActiveTerminalChange,
  onCloseTerminal,
  onHeightChange,
  onAddTerminalContext,
  keybindings,
  terminalBaseLabel,
  terminalLabelOverrides,
  terminalProviderById,
  mode = "drawer",
  onSetTerminalLabelOverride,
  onClearTerminalLabelOverride,
}: ThreadTerminalDrawerProps) {
  const {
    drawerHeight,
    resizeEpoch,
    handleResizePointerDown,
    handleResizePointerMove,
    handleResizePointerEnd,
  } = useThreadTerminalDrawerResize({
    height,
    threadId,
    visible,
    onHeightChange,
  });

  const normalizedTerminalIds = useMemo(() => {
    const cleaned = [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
    return cleaned.length > 0 ? cleaned : [DEFAULT_THREAD_TERMINAL_ID];
  }, [terminalIds]);

  const resolvedActiveTerminalId = normalizedTerminalIds.includes(activeTerminalId)
    ? activeTerminalId
    : (normalizedTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);

  const resolvedTerminalGroups = useMemo(() => {
    const validTerminalIdSet = new Set(normalizedTerminalIds);
    const assignedTerminalIds = new Set<string>();
    const usedGroupIds = new Set<string>();
    const nextGroups: ThreadTerminalGroup[] = [];

    const assignUniqueGroupId = (groupId: string): string => {
      if (!usedGroupIds.has(groupId)) {
        usedGroupIds.add(groupId);
        return groupId;
      }
      let suffix = 2;
      while (usedGroupIds.has(`${groupId}-${suffix}`)) {
        suffix += 1;
      }
      const uniqueGroupId = `${groupId}-${suffix}`;
      usedGroupIds.add(uniqueGroupId);
      return uniqueGroupId;
    };

    for (const terminalGroup of terminalGroups) {
      const nextTerminalIds = [
        ...new Set(terminalGroup.terminalIds.map((id) => id.trim()).filter((id) => id.length > 0)),
      ].filter((terminalId) => {
        if (!validTerminalIdSet.has(terminalId)) return false;
        if (assignedTerminalIds.has(terminalId)) return false;
        return true;
      });
      if (nextTerminalIds.length === 0) continue;

      for (const terminalId of nextTerminalIds) {
        assignedTerminalIds.add(terminalId);
      }

      const baseGroupId =
        terminalGroup.id.trim().length > 0
          ? terminalGroup.id.trim()
          : `group-${nextTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID}`;
      nextGroups.push({
        id: assignUniqueGroupId(baseGroupId),
        terminalIds: nextTerminalIds,
      });
    }

    for (const terminalId of normalizedTerminalIds) {
      if (assignedTerminalIds.has(terminalId)) continue;
      nextGroups.push({
        id: assignUniqueGroupId(`group-${terminalId}`),
        terminalIds: [terminalId],
      });
    }

    if (nextGroups.length > 0) {
      return nextGroups;
    }

    return [
      {
        id: `group-${resolvedActiveTerminalId}`,
        terminalIds: [resolvedActiveTerminalId],
      },
    ];
  }, [normalizedTerminalIds, resolvedActiveTerminalId, terminalGroups]);

  const resolvedActiveGroupIndex = useMemo(() => {
    const indexById = resolvedTerminalGroups.findIndex(
      (terminalGroup) => terminalGroup.id === activeTerminalGroupId,
    );
    if (indexById >= 0) return indexById;
    const indexByTerminal = resolvedTerminalGroups.findIndex((terminalGroup) =>
      terminalGroup.terminalIds.includes(resolvedActiveTerminalId),
    );
    return indexByTerminal >= 0 ? indexByTerminal : 0;
  }, [activeTerminalGroupId, resolvedActiveTerminalId, resolvedTerminalGroups]);

  const visibleTerminalIds = resolvedTerminalGroups[resolvedActiveGroupIndex]?.terminalIds ?? [
    resolvedActiveTerminalId,
  ];
  const hasTerminalSidebar = normalizedTerminalIds.length > 1;
  const showGroupHeaders =
    resolvedTerminalGroups.length > 1 ||
    resolvedTerminalGroups.some((terminalGroup) => terminalGroup.terminalIds.length > 1);
  const hasReachedSplitLimit = visibleTerminalIds.length >= MAX_TERMINALS_PER_GROUP;
  const terminalDefaultLabelById = useMemo(
    () => buildTerminalLabelMap(normalizedTerminalIds, terminalBaseLabel),
    [normalizedTerminalIds, terminalBaseLabel],
  );
  const terminalLabelById = useMemo(
    () => buildTerminalLabelMap(normalizedTerminalIds, terminalBaseLabel, terminalLabelOverrides),
    [normalizedTerminalIds, terminalBaseLabel, terminalLabelOverrides],
  );
  const [editingTerminalId, setEditingTerminalId] = useState<string | null>(null);
  const [terminalRenameDraft, setTerminalRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameTerminalActionLabel = "Rename Terminal";
  const splitTerminalActionLabel = hasReachedSplitLimit
    ? `Split Terminal (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitShortcutLabel
      ? `Split Terminal (${splitShortcutLabel})`
      : "Split Terminal";
  const newTerminalActionLabel = newShortcutLabel
    ? `New Terminal (${newShortcutLabel})`
    : "New Terminal";
  const closeTerminalActionLabel = closeShortcutLabel
    ? `Close Terminal (${closeShortcutLabel})`
    : "Close Terminal";
  const onSplitTerminalAction = useCallback(() => {
    if (hasReachedSplitLimit) return;
    onSplitTerminal();
  }, [hasReachedSplitLimit, onSplitTerminal]);
  const onNewTerminalAction = useCallback(() => {
    onNewTerminal();
  }, [onNewTerminal]);
  const onStartTerminalRename = useCallback(
    (terminalId: string) => {
      setEditingTerminalId(terminalId);
      setTerminalRenameDraft(terminalLabelById.get(terminalId) ?? "");
    },
    [terminalLabelById],
  );
  const onCancelTerminalRename = useCallback(() => {
    setEditingTerminalId(null);
    setTerminalRenameDraft("");
    renameInputRef.current = null;
  }, []);
  const onCommitTerminalRename = useCallback(() => {
    if (!editingTerminalId) {
      return;
    }
    const trimmedDraft = terminalRenameDraft.trim();
    const defaultLabel = terminalDefaultLabelById.get(editingTerminalId)?.trim() ?? "Terminal";
    if (trimmedDraft.length === 0 || trimmedDraft === defaultLabel) {
      onClearTerminalLabelOverride(editingTerminalId);
    } else {
      onSetTerminalLabelOverride(editingTerminalId, trimmedDraft);
    }
    onCancelTerminalRename();
  }, [
    editingTerminalId,
    onCancelTerminalRename,
    onClearTerminalLabelOverride,
    onSetTerminalLabelOverride,
    terminalDefaultLabelById,
    terminalRenameDraft,
  ]);
  const onResetTerminalRename = useCallback(
    (terminalId: string) => {
      onClearTerminalLabelOverride(terminalId);
      if (editingTerminalId === terminalId) {
        onCancelTerminalRename();
      }
    },
    [editingTerminalId, onCancelTerminalRename, onClearTerminalLabelOverride],
  );
  const onRenameInputMount = useCallback((element: HTMLInputElement | null) => {
    if (element && renameInputRef.current !== element) {
      renameInputRef.current = element;
      element.focus();
      element.select();
      return;
    }
    if (element === null && renameInputRef.current !== null) {
      renameInputRef.current = null;
    }
  }, []);

  return (
    <aside
      className={cn(
        "thread-terminal-drawer relative flex min-w-0 shrink-0 flex-col overflow-hidden bg-background",
        mode === "panel" ? "h-full" : "border-t border-border/80",
      )}
      style={mode === "drawer" ? { height: `${drawerHeight}px` } : undefined}
    >
      {mode === "drawer" && (
        <div
          className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerEnd}
          onPointerCancel={handleResizePointerEnd}
        />
      )}

      {!hasTerminalSidebar && (
        <ThreadTerminalDrawerFloatingActions
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
        />
      )}

      {!hasTerminalSidebar && editingTerminalId === resolvedActiveTerminalId && (
        <div className="pointer-events-none absolute left-2 top-2 z-20 max-w-[min(24rem,calc(100%-8rem))]">
          <ThreadTerminalDrawerRenameEditor
            value={terminalRenameDraft}
            placeholder={terminalLabelById.get(resolvedActiveTerminalId) ?? "Terminal"}
            onChange={setTerminalRenameDraft}
            onCommit={onCommitTerminalRename}
            onCancel={onCancelTerminalRename}
            onReset={() => onResetTerminalRename(resolvedActiveTerminalId)}
            autoFocus
            inputRef={onRenameInputMount}
            className="pointer-events-auto"
          />
        </div>
      )}

      <div className="min-h-0 w-full flex-1">
        <div className={`flex h-full min-h-0 ${hasTerminalSidebar ? "gap-1.5" : ""}`}>
          <div className="min-w-0 flex-1">
            <ThreadTerminalDrawerViewport
              threadId={threadId}
              executionTargetId={executionTargetId}
              cwd={cwd}
              worktreePath={worktreePath}
              runtimeEnv={runtimeEnv}
              visible={visible}
              visibleTerminalIds={visibleTerminalIds}
              resolvedActiveTerminalId={resolvedActiveTerminalId}
              terminalLabelById={terminalLabelById}
              focusRequestId={focusRequestId}
              resizeEpoch={resizeEpoch}
              drawerHeight={drawerHeight}
              keybindings={keybindings}
              onActiveTerminalChange={onActiveTerminalChange}
              onCloseTerminal={onCloseTerminal}
              onAddTerminalContext={onAddTerminalContext}
            />
          </div>

          {hasTerminalSidebar && (
            <ThreadTerminalDrawerSidebar
              resolvedTerminalGroups={resolvedTerminalGroups}
              resolvedActiveTerminalId={resolvedActiveTerminalId}
              normalizedTerminalIds={normalizedTerminalIds}
              terminalLabelById={terminalLabelById}
              editingTerminalId={editingTerminalId}
              terminalRenameDraft={terminalRenameDraft}
              renameInputRef={onRenameInputMount}
              terminalProviderById={terminalProviderById}
              showGroupHeaders={showGroupHeaders}
              hasReachedSplitLimit={hasReachedSplitLimit}
              renameTerminalActionLabel={renameTerminalActionLabel}
              splitTerminalActionLabel={splitTerminalActionLabel}
              newTerminalActionLabel={newTerminalActionLabel}
              closeTerminalActionLabel={closeTerminalActionLabel}
              closeShortcutLabel={closeShortcutLabel}
              onTerminalRenameDraftChange={setTerminalRenameDraft}
              onStartTerminalRename={onStartTerminalRename}
              onCommitTerminalRename={onCommitTerminalRename}
              onCancelTerminalRename={onCancelTerminalRename}
              onResetTerminalRename={onResetTerminalRename}
              onSplitTerminalAction={onSplitTerminalAction}
              onNewTerminalAction={onNewTerminalAction}
              onActiveTerminalChange={onActiveTerminalChange}
              onCloseTerminal={onCloseTerminal}
            />
          )}
        </div>
      </div>
    </aside>
  );
}
