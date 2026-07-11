import type { ThreadId } from "@bigbud/contracts";
import { useNavigate } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import { BrowserPanelContent } from "../browser/BrowserPanel";
import { BrowserAgentControlBridge } from "../browser/BrowserAgentControlBridge";
import { BrowserCloseConfirmation } from "../browser/BrowserCloseConfirmation";
import DiffPanel from "../diff/DiffPanel";
import { DiffWorkerPoolProvider } from "../diff/DiffWorkerPoolProvider";
import { FilesPanelContent } from "../files/FilesPanel";
import { GitPanelContent } from "../git-panel/GitPanel";
import { KanbanPanelContent } from "../kanban/KanbanPanel";
import { NotesPanelContent } from "../notes/NotesPanel";
import { TerminalPanelContent } from "../terminal/TerminalPanel";
import { useServerKeybindings } from "~/rpc/serverState";
import { closeBrowserTab, openNewBrowserTab } from "~/stores/browser/browserPanel.actions";
import { closeFilesPanel, openFilesPanel } from "~/stores/files/filesPanel.coordinator";
import { useResolvedGitWorkspace } from "~/hooks/useResolvedGitWorkspace";
import { gitStatusQueryOptions } from "~/lib/gitReactQuery";
import { useQuery } from "@tanstack/react-query";
import { closeDiffPanelIfOpen } from "~/stores/rightPanel/rightPanel.coordinator";
import {
  getRightPanelTabKind,
  useRightPanelTabsStore,
} from "~/stores/rightPanel/rightPanelTabs.store";
import { closeTerminalPanel, openTerminalPanel } from "~/stores/terminal/terminalPanel.coordinator";
import { shortcutLabelForCommand } from "~/models/keybindings";
import { closeGitPanel, openGitPanel } from "~/stores/git/gitPanel.coordinator";
import { closeKanbanPanel, openKanbanPanel } from "~/stores/kanban/kanbanPanel.coordinator";
import { closeNotesPanel, openNotesPanel } from "~/stores/notes/notesPanel.coordinator";
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
  const activeTabId = useRightPanelTabsStore((state) => state.activeTabId);
  const activeKind = useRightPanelTabsStore((state) => state.activeKind);
  const openTabs = useRightPanelTabsStore((state) => state.openTabs);
  const { cwd, executionTargetId } = useResolvedGitWorkspace(activeThreadId);
  const { panelWidth, onResizePointerDown } = useRightPanelWidth();
  const gitStatusQuery = useQuery({
    ...gitStatusQueryOptions(cwd, executionTargetId),
    enabled: rightPanelOpen && cwd !== null,
  });
  const workspaceRoot = cwd;
  const isGitRepo = gitStatusQuery.data?.isRepo ?? false;

  const browserShortcutLabel = shortcutLabelForCommand(keybindings, "browser.toggle");
  const filesShortcutLabel = shortcutLabelForCommand(keybindings, "files.toggle");
  const gitShortcutLabel = shortcutLabelForCommand(keybindings, "git.toggle");
  const terminalShortcutLabel = shortcutLabelForCommand(keybindings, "terminal.toggle");
  const diffShortcutLabel = shortcutLabelForCommand(keybindings, "diff.toggle");
  const notesShortcutLabel = shortcutLabelForCommand(keybindings, "notes.toggle");

  const openDiff = () => openDiffPanel(navigate, activeThreadId);

  return (
    <RightPanelShell
      open={rightPanelOpen}
      width={panelWidth}
      onResizePointerDown={onResizePointerDown}
      resizeAriaLabel="Resize right panel"
    >
      <BrowserAgentControlBridge />
      <BrowserCloseConfirmation />
      <RightPanelTabs
        browserShortcutLabel={browserShortcutLabel}
        diffShortcutLabel={diffShortcutLabel}
        filesShortcutLabel={filesShortcutLabel}
        gitShortcutLabel={gitShortcutLabel}
        kanbanShortcutLabel={null}
        hasActiveProject={Boolean(workspaceRoot)}
        isGitRepo={isGitRepo}
        onCloseBrowserTab={closeBrowserTab}
        onCloseDiff={closeDiffPanelIfOpen}
        onCloseFiles={closeFilesPanel}
        onCloseGit={closeGitPanel}
        onCloseKanban={closeKanbanPanel}
        onCloseNotes={closeNotesPanel}
        onCloseTerminal={closeTerminalPanel}
        onOpenNewBrowserTab={openNewBrowserTab}
        onOpenDiff={openDiff}
        onOpenFiles={openFilesPanel}
        onOpenGit={openGitPanel}
        onOpenKanban={openKanbanPanel}
        onOpenNotes={openNotesPanel}
        onOpenTerminal={openTerminalPanel}
        notesShortcutLabel={notesShortcutLabel}
        terminalAvailable={Boolean(workspaceRoot)}
        terminalShortcutLabel={terminalShortcutLabel}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {rightPanelOpen && (activeKind === null || openTabs.length > 0) ? (
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {activeKind === null ? (
              <div className="absolute inset-0 flex min-h-0 flex-col overflow-auto">
                <RightPanelLauncher
                  browserShortcutLabel={browserShortcutLabel}
                  diffShortcutLabel={diffShortcutLabel}
                  filesShortcutLabel={filesShortcutLabel}
                  gitShortcutLabel={gitShortcutLabel}
                  kanbanShortcutLabel={null}
                  hasActiveProject={Boolean(workspaceRoot)}
                  isGitRepo={isGitRepo}
                  onToggleBrowser={openNewBrowserTab}
                  onToggleDiff={openDiff}
                  onToggleFiles={openFilesPanel}
                  onToggleGit={openGitPanel}
                  onToggleKanban={openKanbanPanel}
                  onToggleNotes={openNotesPanel}
                  onToggleTerminal={openTerminalPanel}
                  notesShortcutLabel={notesShortcutLabel}
                  terminalAvailable={Boolean(workspaceRoot)}
                  terminalShortcutLabel={terminalShortcutLabel}
                />
              </div>
            ) : null}
            {openTabs.map((tabId) => {
              const kind = getRightPanelTabKind(tabId);
              const isActive = activeTabId === tabId && rightPanelOpen;

              if (kind === "browser") {
                return (
                  <div
                    key={tabId}
                    className={cn(
                      "absolute inset-0 flex min-h-0 flex-1 flex-col overflow-hidden",
                      !isActive && "pointer-events-none invisible",
                    )}
                    inert={!isActive ? true : undefined}
                  >
                    <BrowserPanelContent
                      activeThreadId={activeThreadId ?? null}
                      tabId={tabId}
                      visible={isActive}
                    />
                  </div>
                );
              }

              if (kind === "files") {
                return (
                  <div
                    key={tabId}
                    className={cn(
                      "absolute inset-0 flex min-h-0 flex-1 flex-col overflow-hidden",
                      !isActive && "pointer-events-none invisible",
                    )}
                    inert={!isActive ? true : undefined}
                  >
                    <FilesPanelContent activeThreadId={activeThreadId ?? null} />
                  </div>
                );
              }

              if (kind === "terminal") {
                return (
                  <div
                    key={tabId}
                    className={cn(
                      "absolute inset-0 flex min-h-0 flex-1 flex-col overflow-hidden",
                      !isActive && "pointer-events-none invisible",
                    )}
                    inert={!isActive ? true : undefined}
                  >
                    <TerminalPanelContent activeThreadId={activeThreadId ?? null} />
                  </div>
                );
              }

              if (kind === "notes") {
                return (
                  <div
                    key={tabId}
                    className={cn(
                      "absolute inset-0 flex min-h-0 flex-1 flex-col overflow-hidden",
                      !isActive && "pointer-events-none invisible",
                    )}
                    inert={!isActive ? true : undefined}
                  >
                    <NotesPanelContent activeThreadId={activeThreadId ?? null} />
                  </div>
                );
              }

              if (kind === "kanban") {
                return (
                  <div
                    key={tabId}
                    className={cn(
                      "absolute inset-0 flex min-h-0 flex-1 flex-col overflow-hidden",
                      !isActive && "pointer-events-none invisible",
                    )}
                    inert={!isActive ? true : undefined}
                  >
                    <KanbanPanelContent activeThreadId={activeThreadId ?? null} />
                  </div>
                );
              }

              if (kind === "git") {
                return (
                  <div
                    key={tabId}
                    className={cn(
                      "absolute inset-0 flex min-h-0 flex-1 flex-col overflow-hidden",
                      !isActive && "pointer-events-none invisible",
                    )}
                    inert={!isActive ? true : undefined}
                  >
                    <DiffWorkerPoolProvider>
                      <GitPanelContent activeThreadId={activeThreadId ?? null} visible={isActive} />
                    </DiffWorkerPoolProvider>
                  </div>
                );
              }

              if (kind === "diff") {
                return (
                  <div
                    key={tabId}
                    className={cn(
                      "absolute inset-0 flex min-h-0 flex-1 flex-col overflow-hidden",
                      !isActive && "pointer-events-none invisible",
                    )}
                    inert={!isActive ? true : undefined}
                  >
                    <DiffWorkerPoolProvider>
                      <DiffPanel mode="sidebar" />
                    </DiffWorkerPoolProvider>
                  </div>
                );
              }

              return null;
            })}
          </div>
        ) : null}
      </div>
    </RightPanelShell>
  );
}
