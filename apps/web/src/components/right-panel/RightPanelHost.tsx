import type { ThreadId } from "@bigbud/contracts";
import { useNavigate } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
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
  const openTabs = useRightPanelTabsStore((state) => state.openTabs);
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
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {openTabs.length === 0 ? (
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
        ) : null}
        {openTabs.length > 0 ? (
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {openTabs.includes("browser") ? (
              <div
                className={cn(
                  "absolute inset-0 flex min-h-0 flex-1 flex-col overflow-hidden",
                  activeKind !== "browser" && "pointer-events-none invisible",
                )}
                aria-hidden={activeKind !== "browser"}
              >
                <BrowserPanelContent activeThreadId={activeThreadId ?? null} />
              </div>
            ) : null}
            {openTabs.includes("files") ? (
              <div
                className={cn(
                  "absolute inset-0 flex min-h-0 flex-1 flex-col overflow-hidden",
                  activeKind !== "files" && "pointer-events-none invisible",
                )}
                aria-hidden={activeKind !== "files"}
              >
                <FilesPanelContent activeThreadId={activeThreadId ?? null} />
              </div>
            ) : null}
            {openTabs.includes("terminal") ? (
              <div
                className={cn(
                  "absolute inset-0 flex min-h-0 flex-1 flex-col overflow-hidden",
                  activeKind !== "terminal" && "pointer-events-none invisible",
                )}
                aria-hidden={activeKind !== "terminal"}
              >
                <TerminalPanelContent activeThreadId={activeThreadId ?? null} />
              </div>
            ) : null}
            {openTabs.includes("diff") ? (
              <div
                className={cn(
                  "absolute inset-0 flex min-h-0 flex-1 flex-col overflow-hidden",
                  activeKind !== "diff" && "pointer-events-none invisible",
                )}
                aria-hidden={activeKind !== "diff"}
              >
                <DiffWorkerPoolProvider>
                  <DiffPanel mode="sidebar" />
                </DiffWorkerPoolProvider>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </RightPanelShell>
  );
}
