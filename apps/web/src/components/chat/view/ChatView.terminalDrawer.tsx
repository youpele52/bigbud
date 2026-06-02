import type { ResolvedKeybindingsConfig, ThreadId } from "@bigbud/contracts";
import { useCallback } from "react";
import { useThreadTerminalDrawer } from "../../terminal/useThreadTerminalDrawer";
import ThreadTerminalDrawer from "../../terminal/ThreadTerminalDrawer";
import type { TerminalContextSelection } from "../../../lib/terminalContext";

interface PersistentThreadTerminalDrawerProps {
  threadId: ThreadId;
  visible: boolean;
  launchContext: PersistentTerminalLaunchContext | null;
  focusRequestId: number;
  splitShortcutLabel: string | undefined;
  newShortcutLabel: string | undefined;
  closeShortcutLabel: string | undefined;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

interface PersistentTerminalLaunchContext {
  cwd: string;
  worktreePath: string | null;
}

export function PersistentThreadTerminalDrawer({
  threadId,
  visible,
  launchContext,
  focusRequestId,
  splitShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  keybindings,
  onAddTerminalContext,
}: PersistentThreadTerminalDrawerProps) {
  const drawer = useThreadTerminalDrawer(threadId, launchContext, visible);

  const handleAddTerminalContext = useCallback(
    (selection: TerminalContextSelection) => {
      if (!visible) {
        return;
      }
      onAddTerminalContext(selection);
    },
    [onAddTerminalContext, visible],
  );

  if (!drawer.project || !drawer.terminalState.terminalOpen || !drawer.cwd) {
    return null;
  }

  return (
    <div className={visible ? undefined : "hidden"}>
      <ThreadTerminalDrawer
        threadId={threadId}
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
        focusRequestId={focusRequestId + drawer.focusRequestId}
        onSplitTerminal={drawer.splitTerminal}
        onNewTerminal={drawer.createNewTerminal}
        splitShortcutLabel={visible ? splitShortcutLabel : undefined}
        newShortcutLabel={visible ? newShortcutLabel : undefined}
        closeShortcutLabel={visible ? closeShortcutLabel : undefined}
        keybindings={keybindings}
        onActiveTerminalChange={drawer.activateTerminal}
        onCloseTerminal={drawer.closeTerminal}
        onHeightChange={drawer.setTerminalHeight}
        onAddTerminalContext={handleAddTerminalContext}
      />
    </div>
  );
}
