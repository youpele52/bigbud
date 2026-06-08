import { RightPanelShell } from "./RightPanelShell";
import { RightPanelTabs } from "./RightPanelTabs";
import { RightPanelLauncher } from "./RightPanelLauncher";
import { useRightPanelTabsStore } from "~/stores/rightPanel/rightPanelTabs.store";
import { useRightPanelWidth } from "./useRightPanelWidth";
import { closeBrowserTab, openNewBrowserTab } from "~/stores/browser/browserPanel.actions";
import { closeFilesPanel, openFilesPanel } from "~/stores/files/filesPanel.coordinator";
import { closeGitPanel } from "~/stores/git/gitPanel.coordinator";
import { closeNotesPanel, openNotesPanel } from "~/stores/notes/notesPanel.coordinator";
import { closeTerminalPanel, openTerminalPanel } from "~/stores/terminal/terminalPanel.coordinator";
import { useQuery } from "@tanstack/react-query";
import { useResolvedGitWorkspace } from "~/hooks/useResolvedGitWorkspace";
import { gitStatusQueryOptions } from "~/lib/gitReactQuery";
import { useServerKeybindings } from "~/rpc/serverState";
import { shortcutLabelForCommand } from "~/models/keybindings";
import type { ThreadId } from "@bigbud/contracts";

interface RightPanelLauncherPanelProps {
  activeThreadId?: ThreadId | null;
  onToggleDiff: () => void;
  onToggleFiles: () => void;
  onToggleGit: () => void;
  onToggleTerminal: () => void;
}

export function RightPanelLauncherPanel({
  activeThreadId,
  onToggleDiff,
  onToggleFiles,
  onToggleGit,
  onToggleTerminal,
}: RightPanelLauncherPanelProps) {
  const keybindings = useServerKeybindings();
  const rightPanelOpen = useRightPanelTabsStore((state) => state.rightPanelOpen);
  const activeKind = useRightPanelTabsStore((state) => state.activeKind);
  const { cwd, executionTargetId } = useResolvedGitWorkspace(activeThreadId);
  const workspaceRoot = cwd;
  const gitStatusQuery = useQuery({
    ...gitStatusQueryOptions(cwd, executionTargetId),
    enabled: rightPanelOpen && cwd !== null,
  });

  const { panelWidth, onResizePointerDown } = useRightPanelWidth();

  const browserShortcutLabel = shortcutLabelForCommand(keybindings, "browser.toggle");
  const filesShortcutLabel = shortcutLabelForCommand(keybindings, "files.toggle");
  const gitShortcutLabel = shortcutLabelForCommand(keybindings, "git.toggle");
  const terminalShortcutLabel = shortcutLabelForCommand(keybindings, "terminal.toggle");
  const diffShortcutLabel = shortcutLabelForCommand(keybindings, "diff.toggle");
  const notesShortcutLabel = null;

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
        gitShortcutLabel={gitShortcutLabel}
        hasActiveProject={Boolean(workspaceRoot)}
        isGitRepo={gitStatusQuery.data?.isRepo ?? false}
        onCloseBrowserTab={closeBrowserTab}
        onCloseFiles={closeFilesPanel}
        onCloseGit={closeGitPanel}
        onCloseNotes={closeNotesPanel}
        onCloseTerminal={closeTerminalPanel}
        onOpenNewBrowserTab={openNewBrowserTab}
        onOpenDiff={onToggleDiff}
        onOpenFiles={openFilesPanel}
        onOpenGit={onToggleGit}
        onOpenNotes={openNotesPanel}
        onOpenTerminal={openTerminalPanel}
        notesShortcutLabel={notesShortcutLabel}
        terminalAvailable={Boolean(workspaceRoot)}
        terminalShortcutLabel={terminalShortcutLabel}
      />
      <RightPanelLauncher
        browserShortcutLabel={browserShortcutLabel}
        diffShortcutLabel={diffShortcutLabel}
        filesShortcutLabel={filesShortcutLabel}
        gitShortcutLabel={gitShortcutLabel}
        hasActiveProject={Boolean(workspaceRoot)}
        isGitRepo={gitStatusQuery.data?.isRepo ?? false}
        onToggleBrowser={openNewBrowserTab}
        onToggleDiff={onToggleDiff}
        onToggleFiles={onToggleFiles}
        onToggleGit={onToggleGit}
        onToggleNotes={openNotesPanel}
        onToggleTerminal={onToggleTerminal}
        notesShortcutLabel={notesShortcutLabel}
        terminalAvailable={Boolean(workspaceRoot)}
        terminalShortcutLabel={terminalShortcutLabel}
      />
    </RightPanelShell>
  );
}
