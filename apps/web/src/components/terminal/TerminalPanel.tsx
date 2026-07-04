import { type ThreadId } from "@bigbud/contracts";
import { memo, useCallback, useEffect } from "react";

import { isElectron } from "~/config/env";
import { cn, randomUUID } from "~/lib/utils";
import { useServerKeybindings } from "../../rpc/serverState";
import { useComposerDraftStore } from "../../stores/composer";
import { useTerminalStateStore } from "../../stores/terminal";
import { useTerminalPanelStore } from "../../stores/terminal/terminalPanel.store";
import { normalizeTerminalContextSelection } from "../../lib/terminalContext";
import { useThreadTerminalDrawer } from "./useThreadTerminalDrawer";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";

interface TerminalPanelProps {
  activeThreadId?: ThreadId | null;
}

export const TerminalPanelContent = memo(function TerminalPanelContent({
  activeThreadId,
}: TerminalPanelProps) {
  const open = useTerminalPanelStore((state) => state.open);
  const keybindings = useServerKeybindings();
  const hasPanelTerminalState = useTerminalStateStore((state) =>
    activeThreadId ? state.panelTerminalStateByThreadId[activeThreadId] !== undefined : false,
  );
  const ensurePanelTerminal = useTerminalStateStore((state) => state.ensurePanelTerminal);
  const drawer = useThreadTerminalDrawer(activeThreadId ?? ("" as ThreadId), null, open, "panel");

  useEffect(() => {
    if (!open || !activeThreadId || !drawer.cwd || hasPanelTerminalState) return;
    ensurePanelTerminal(activeThreadId, `terminal-${randomUUID()}`, { active: true });
  }, [activeThreadId, drawer.cwd, ensurePanelTerminal, hasPanelTerminalState, open]);

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
  } else if (activeThreadId && drawer.cwd && !hasPanelTerminalState) {
    body = (
      <div className="flex h-full items-center justify-center px-3 py-2 text-sm text-muted-foreground/70">
        Initializing terminal...
      </div>
    );
  } else if (activeThreadId && drawer.project && drawer.cwd && hasPanelTerminalState) {
    body = (
      <ThreadTerminalDrawer
        mode="panel"
        threadId={activeThreadId}
        executionTargetId={drawer.executionTargetId}
        cwd={drawer.cwd}
        worktreePath={drawer.effectiveWorktreePath}
        runtimeEnv={drawer.runtimeEnv}
        visible={open}
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
        terminalProvider={drawer.terminalProvider}
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
