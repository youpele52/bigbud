import type { ThreadId } from "@bigbud/contracts";
import { useNavigate } from "@tanstack/react-router";

import { BrowserPanelContent } from "../browser/BrowserPanel";
import DiffPanel from "../diff/DiffPanel";
import { DiffWorkerPoolProvider } from "../diff/DiffWorkerPoolProvider";
import { FilesPanelContent } from "../files/FilesPanel";
import { TerminalPanelContent } from "../terminal/TerminalPanel";
import { useServerKeybindings } from "~/rpc/serverState";
import { useDefaultChatCwd } from "~/rpc/serverState";
import { closeBrowserPanel, openBrowserPanel } from "~/stores/browser/browserPanel.actions";
import { closeFilesPanel, openFilesPanel } from "~/stores/files/filesPanel.coordinator";
import { useProjectById, useThreadById } from "~/stores/main";
import { closeDiffPanelIfOpen } from "~/stores/rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "~/stores/rightPanel/rightPanelTabs.store";
import { closeTerminalPanel, openTerminalPanel } from "~/stores/terminal/terminalPanel.coordinator";
import { useUiStateStore } from "~/stores/ui";
import { shortcutLabelForCommand } from "~/models/keybindings";
import { openDiffPanel } from "./openDiffPanel";
import { RightPanelLauncher } from "./RightPanelLauncher";
import { RightPanelShell } from "./RightPanelShell";
import { RightPanelTabs } from "./RightPanelTabs";
import { useRightPanelWidth } from "./useRightPanelWidth";

interface RightPanelHostProps {
  activeThreadId?: ThreadId | null;
}

export function RightPanelHost({ activeThreadId }: RightPanelHostProps) {
  const navigate = useNavigate();
  const keybindings = useServerKeybindings();
  const rightPanelOpen = useRightPanelTabsStore((state) => state.rightPanelOpen);
  const activeKind = useRightPanelTabsStore((state) => state.activeKind);
  const thread = useThreadById(activeThreadId ?? null);
  const selectedProjectId = useUiStateStore((state) => state.selectedProjectId);
  const project = useProjectById(thread?.projectId ?? selectedProjectId ?? null);
  const defaultChatCwd = useDefaultChatCwd();
  const { panelWidth, onResizePointerDown } = useRightPanelWidth();
  const workspaceRoot = thread?.worktreePath ?? project?.cwd ?? defaultChatCwd ?? null;

  const browserShortcutLabel = shortcutLabelForCommand(keybindings, "browser.toggle");
  const filesShortcutLabel = shortcutLabelForCommand(keybindings, "files.toggle");
  const terminalShortcutLabel = shortcutLabelForCommand(keybindings, "terminal.toggle");
  const diffShortcutLabel = shortcutLabelForCommand(keybindings, "diff.toggle");

  const openDiff = () => openDiffPanel(navigate, activeThreadId);

  const content =
    activeKind === "browser" ? (
      <BrowserPanelContent activeThreadId={activeThreadId ?? null} />
    ) : activeKind === "files" ? (
      <FilesPanelContent activeThreadId={activeThreadId ?? null} />
    ) : activeKind === "terminal" ? (
      <TerminalPanelContent activeThreadId={activeThreadId ?? null} />
    ) : activeKind === "diff" ? (
      <DiffWorkerPoolProvider>
        <DiffPanel mode="sidebar" />
      </DiffWorkerPoolProvider>
    ) : (
      <RightPanelLauncher
        browserShortcutLabel={browserShortcutLabel}
        diffShortcutLabel={diffShortcutLabel}
        filesShortcutLabel={filesShortcutLabel}
        hasActiveProject={Boolean(workspaceRoot)}
        isGitRepo={Boolean(activeThreadId)}
        onToggleBrowser={openBrowserPanel}
        onToggleDiff={openDiff}
        onToggleFiles={openFilesPanel}
        onToggleTerminal={openTerminalPanel}
        terminalAvailable={Boolean(workspaceRoot)}
        terminalShortcutLabel={terminalShortcutLabel}
      />
    );

  return (
    <RightPanelShell
      open={rightPanelOpen}
      width={panelWidth}
      onResizePointerDown={onResizePointerDown}
      resizeAriaLabel="Resize right panel"
    >
      <RightPanelTabs
        browserShortcutLabel={browserShortcutLabel}
        diffShortcutLabel={diffShortcutLabel}
        filesShortcutLabel={filesShortcutLabel}
        hasActiveProject={Boolean(workspaceRoot)}
        isGitRepo={Boolean(activeThreadId)}
        onCloseBrowser={closeBrowserPanel}
        onCloseDiff={closeDiffPanelIfOpen}
        onCloseFiles={closeFilesPanel}
        onCloseTerminal={closeTerminalPanel}
        onOpenBrowser={openBrowserPanel}
        onOpenDiff={openDiff}
        onOpenFiles={openFilesPanel}
        onOpenTerminal={openTerminalPanel}
        terminalAvailable={Boolean(workspaceRoot)}
        terminalShortcutLabel={terminalShortcutLabel}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{content}</div>
    </RightPanelShell>
  );
}
