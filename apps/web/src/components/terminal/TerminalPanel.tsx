import { type ThreadId } from "@bigbud/contracts";
import { memo, useCallback, useEffect } from "react";
import { normalizeTerminalContextSelection } from "../../lib/terminalContext";
import { randomUUID } from "~/lib/utils";
import { isElectron } from "~/config/env";
import { cn } from "~/lib/utils";
import { useServerKeybindings } from "../../rpc/serverState";
import { useComposerDraftStore } from "../../stores/composer";
import { closeBrowserPanel, openBrowserPanel } from "../../stores/browser/browserPanel.actions";
import { closeFilesPanel, openFilesPanel } from "../../stores/files/filesPanel.coordinator";
import { useRightPanelTabsStore } from "../../stores/rightPanel/rightPanelTabs.store";
import { useTerminalStateStore } from "../../stores/terminal";
import {
  closeTerminalPanel,
  openTerminalPanel,
} from "../../stores/terminal/terminalPanel.coordinator";
import { useTerminalPanelStore } from "../../stores/terminal/terminalPanel.store";
import { RightPanelShell } from "../right-panel/RightPanelShell";
import { RightPanelTabs } from "../right-panel/RightPanelTabs";
import { useRightPanelWidth } from "../right-panel/useRightPanelWidth";
import { useThreadTerminalDrawer } from "./useThreadTerminalDrawer";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";

const TERMINAL_PANEL_MIN_WIDTH = 360;
const TERMINAL_PANEL_WIDTH_STORAGE_KEY = "terminal_panel_width";

interface TerminalPanelProps {
  activeThreadId?: ThreadId | null;
}

export const TerminalPanel = memo(function TerminalPanel({ activeThreadId }: TerminalPanelProps) {
  const open = useTerminalPanelStore((state) => state.open);
  const activeTab = useRightPanelTabsStore((state) => state.activeKind);
  const { panelWidth, onResizePointerDown } = useRightPanelWidth({
    minWidth: TERMINAL_PANEL_MIN_WIDTH,
    storageKey: TERMINAL_PANEL_WIDTH_STORAGE_KEY,
  });
  const keybindings = useServerKeybindings();

  const drawer = useThreadTerminalDrawer(activeThreadId ?? ("" as ThreadId), null, open, "panel");
  const ensurePanelTerminal = useTerminalStateStore((state) => state.ensurePanelTerminal);
  const panelTerminalState = useTerminalStateStore((state) =>
    activeThreadId ? (state.panelTerminalStateByThreadId[activeThreadId] ?? null) : null,
  );

  useEffect(() => {
    if (!open || !activeThreadId || panelTerminalState) return;
    ensurePanelTerminal(activeThreadId, `terminal-${randomUUID()}`, { active: true });
  }, [open, activeThreadId, panelTerminalState, ensurePanelTerminal]);

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

  const visible = open && activeTab === "terminal";

  if (!visible || !panelTerminalState || !drawer.project || !drawer.cwd) {
    return null;
  }

  return (
    <RightPanelShell
      open={open}
      width={panelWidth}
      onResizePointerDown={onResizePointerDown}
      resizeAriaLabel="Resize terminal panel"
    >
      <div className="flex h-full flex-col">
        <RightPanelTabs
          browserShortcutLabel={null}
          filesShortcutLabel={null}
          hasActiveProject
          onCloseBrowser={closeBrowserPanel}
          onCloseFiles={closeFilesPanel}
          onCloseTerminal={closeTerminalPanel}
          onOpenBrowser={openBrowserPanel}
          onOpenFiles={openFilesPanel}
          onOpenTerminal={openTerminalPanel}
          terminalAvailable
          terminalShortcutLabel={null}
        />
        <div className={cn("border-b border-border px-3", isElectron ? "py-3" : "py-2")}>
          <p className="text-sm font-medium text-foreground">Terminal</p>
        </div>
        <div className="min-h-0 flex-1">
          <ThreadTerminalDrawer
            mode="panel"
            threadId={activeThreadId ?? ("" as ThreadId)}
            executionTargetId={drawer.executionTargetId}
            cwd={drawer.cwd}
            worktreePath={drawer.effectiveWorktreePath}
            runtimeEnv={drawer.runtimeEnv}
            visible={visible}
            height={drawer.terminalState.terminalHeight}
            terminalIds={drawer.terminalState.terminalIds}
            activeTerminalId={drawer.terminalState.activeTerminalId}
            terminalGroups={drawer.terminalState.terminalGroups}
            activeTerminalGroupId={drawer.terminalState.activeTerminalGroupId}
            focusRequestId={drawer.focusRequestId}
            onSplitTerminal={drawer.splitTerminal}
            onNewTerminal={drawer.createNewTerminal}
            keybindings={keybindings}
            onActiveTerminalChange={drawer.activateTerminal}
            onCloseTerminal={drawer.closeTerminal}
            onHeightChange={drawer.setTerminalHeight}
            onAddTerminalContext={handleAddTerminalContext}
          />
        </div>
      </div>
    </RightPanelShell>
  );
});

export default TerminalPanel;
