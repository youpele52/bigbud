import { RightPanelShell } from "./RightPanelShell";
import { RightPanelTabs } from "./RightPanelTabs";
import { RightPanelLauncher } from "./RightPanelLauncher";
import { useRightPanelTabsStore } from "~/stores/rightPanel/rightPanelTabs.store";
import { useRightPanelWidth } from "./useRightPanelWidth";
import { closeBrowserPanel } from "~/stores/browser/browserPanel.actions";
import { closeFilesPanel, openFilesPanel } from "~/stores/files/filesPanel.coordinator";
import { closeTerminalPanel, openTerminalPanel } from "~/stores/terminal/terminalPanel.coordinator";
import { useDefaultChatCwd } from "~/rpc/serverState";
import { useProjectById, useThreadById } from "~/stores/main";
import { useUiStateStore } from "~/stores/ui";
import { useServerKeybindings } from "~/rpc/serverState";
import { shortcutLabelForCommand } from "~/models/keybindings";
import type { ThreadId } from "@bigbud/contracts";

interface RightPanelLauncherPanelProps {
  activeThreadId?: ThreadId | null;
  onToggleBrowser: () => void;
  onToggleDiff: () => void;
  onToggleFiles: () => void;
  onToggleTerminal: () => void;
}

export function RightPanelLauncherPanel({
  activeThreadId,
  onToggleBrowser,
  onToggleDiff,
  onToggleFiles,
  onToggleTerminal,
}: RightPanelLauncherPanelProps) {
  const keybindings = useServerKeybindings();
  const rightPanelOpen = useRightPanelTabsStore((state) => state.rightPanelOpen);
  const activeKind = useRightPanelTabsStore((state) => state.activeKind);
  const thread = useThreadById(activeThreadId ?? null);
  const selectedProjectId = useUiStateStore((state) => state.selectedProjectId);
  const project = useProjectById(thread?.projectId ?? selectedProjectId ?? null);
  const defaultChatCwd = useDefaultChatCwd();
  const workspaceRoot = thread?.worktreePath ?? project?.cwd ?? defaultChatCwd ?? null;

  const { panelWidth, onResizePointerDown } = useRightPanelWidth();

  const browserShortcutLabel = shortcutLabelForCommand(keybindings, "browser.toggle");
  const filesShortcutLabel = shortcutLabelForCommand(keybindings, "files.toggle");
  const terminalShortcutLabel = shortcutLabelForCommand(keybindings, "terminal.toggle");
  const diffShortcutLabel = shortcutLabelForCommand(keybindings, "diff.toggle");

  const showLauncher = rightPanelOpen && activeKind === null;

  if (!showLauncher) return null;

  return (
    <RightPanelShell
      open={true}
      width={panelWidth}
      onResizePointerDown={onResizePointerDown}
      resizeAriaLabel="Resize right panel"
    >
      <RightPanelTabs
        browserShortcutLabel={browserShortcutLabel}
        diffShortcutLabel={diffShortcutLabel}
        filesShortcutLabel={filesShortcutLabel}
        hasActiveProject={Boolean(workspaceRoot)}
        isGitRepo={true}
        onCloseBrowser={closeBrowserPanel}
        onCloseFiles={closeFilesPanel}
        onCloseTerminal={closeTerminalPanel}
        onOpenBrowser={onToggleBrowser}
        onOpenDiff={onToggleDiff}
        onOpenFiles={openFilesPanel}
        onOpenTerminal={openTerminalPanel}
        terminalAvailable={Boolean(workspaceRoot)}
        terminalShortcutLabel={terminalShortcutLabel}
      />
      <RightPanelLauncher
        browserShortcutLabel={browserShortcutLabel}
        diffShortcutLabel={diffShortcutLabel}
        filesShortcutLabel={filesShortcutLabel}
        hasActiveProject={Boolean(workspaceRoot)}
        isGitRepo={true}
        onToggleBrowser={onToggleBrowser}
        onToggleDiff={onToggleDiff}
        onToggleFiles={onToggleFiles}
        onToggleTerminal={onToggleTerminal}
        terminalAvailable={Boolean(workspaceRoot)}
        terminalShortcutLabel={terminalShortcutLabel}
      />
    </RightPanelShell>
  );
}
