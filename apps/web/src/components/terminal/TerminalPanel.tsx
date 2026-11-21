import { type ThreadId } from "@bigbud/contracts";
import { memo, useCallback } from "react";

import { isElectron } from "~/config/env";
import { cn, randomUUID } from "~/lib/utils";
import { useServerKeybindings } from "../../rpc/serverState";
import { useComposerDraftStore } from "../../stores/composer";
import { useTerminalStateStore } from "../../stores/terminal";
import { createTerminalPaneId } from "../../stores/terminal/terminal.store.create";
import { useTerminalPanelStore } from "../../stores/terminal/terminalPanel.store";
import { normalizeTerminalContextSelection } from "../../lib/terminalContext";
import { useThreadTerminalDrawer } from "./useThreadTerminalDrawer";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import { Button } from "../ui/button";

interface TerminalPanelProps {
  activeThreadId?: ThreadId | null;
  visible?: boolean;
}

export const TerminalPanelContent = memo(function TerminalPanelContent({
  activeThreadId,
  visible = true,
}: TerminalPanelProps) {
  const open = useTerminalPanelStore((state) => state.open);
  const keybindings = useServerKeybindings();
  // Showing the panel or switching threads never creates a terminal (plan D1, §11.1).
  const hasPanelTerminals = useTerminalStateStore((state) =>
    activeThreadId
      ? (state.panelTerminalStateByThreadId[activeThreadId]?.terminalIds.length ?? 0) > 0
      : false,
  );
  const newPanelTerminal = useTerminalStateStore((state) => state.newPanelTerminal);
  const drawer = useThreadTerminalDrawer(activeThreadId ?? ("" as ThreadId), null, open, "panel");
  const { bumpFocusRequestId } = drawer;

  const handleNewTerminal = useCallback(() => {
    if (!activeThreadId) return;
    newPanelTerminal(activeThreadId, createTerminalPaneId());
    bumpFocusRequestId();
  }, [activeThreadId, bumpFocusRequestId, newPanelTerminal]);

  const handleAddTerminalContext = useCallback(
    (selection: Parameters<typeof normalizeTerminalContextSelection>[0]) => {
      if (!activeThreadId) return;
      const normalized = normalizeTerminalContextSelection(selection);
      if (!normalized) return;

      useComposerDraftStore.getState().addTerminalContext(activeThreadId, {
        id: randomUUID(),
        threadId: activeThreadId,
        createdAt: new Date().toISOString(),
        ...normalized,
      });
    },
    [activeThreadId],
  );

  let body = (
    <div className="flex h-full items-center justify-center px-3 py-2 text-sm text-muted-foreground/70">
      Open a thread to use the terminal.
    </div>
  );

  if (activeThreadId && !drawer.cwd) {
    body = (
      <div className="flex h-full items-center justify-center px-3 py-2 text-sm text-muted-foreground/70">
        Select a project with a workspace before opening the terminal.
      </div>
    );
  } else if (activeThreadId && drawer.project && drawer.cwd && !hasPanelTerminals) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-3 py-2 text-center">
        <p className="text-sm text-muted-foreground/70">No terminal in this thread.</p>
        <Button variant="outline" size="sm" onClick={handleNewTerminal}>
          New terminal
        </Button>
      </div>
    );
  } else if (activeThreadId && drawer.project && drawer.cwd && hasPanelTerminals) {
    body = (
      <ThreadTerminalDrawer
        mode="panel"
        threadId={activeThreadId}
        executionTargetId={drawer.executionTargetId}
        cwd={drawer.cwd}
        worktreePath={drawer.effectiveWorktreePath}
        runtimeEnv={drawer.runtimeEnv}
        visible={open && visible}
        height={drawer.terminalState.terminalHeight}
        terminalIds={drawer.terminalState.terminalIds}
        activeTerminalId={drawer.terminalState.activeTerminalId}
        terminalGroups={drawer.terminalState.terminalGroups}
        activeTerminalGroupId={drawer.terminalState.activeTerminalGroupId}
        focusRequestId={drawer.focusRequestId}
        onSplitTerminal={drawer.splitTerminal}
        onNewTerminal={drawer.createNewTerminal}
        keybindings={keybindings}
        terminalBaseLabel={drawer.terminalBaseLabel}
        terminalLabelOverrides={drawer.terminalLabelOverrides}
        terminalProviderById={drawer.terminalProviderById}
        onActiveTerminalChange={drawer.activateTerminal}
        onCloseTerminal={drawer.closeTerminal}
        onSetTerminalLabelOverride={drawer.setTerminalLabelOverride}
        onClearTerminalLabelOverride={drawer.clearTerminalLabelOverride}
        onHeightChange={drawer.setTerminalHeight}
        onAddTerminalContext={handleAddTerminalContext}
      />
    );
  }

  return (
    <>
      <div className={cn("border-b border-border px-3 py-3", isElectron && "drag-region")}>
        <p className="text-sm font-medium text-foreground">Terminal</p>
      </div>
      <div className="min-h-0 flex-1">{body}</div>
    </>
  );
});

const TerminalPanel = memo(function TerminalPanel(props: TerminalPanelProps) {
  return <TerminalPanelContent {...props} />;
});

export default TerminalPanel;
