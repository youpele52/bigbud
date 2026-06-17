import { BUILT_IN_CHATS_PROJECT_ID, isBuiltInChatsProject } from "@bigbud/contracts";
import { Outlet, createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useCallback } from "react";

import {
  resolveContextualNewThreadOptions,
  resolveNewChatOptions,
  useHandleNewThread,
} from "../hooks/useHandleNewThread";
import { isTerminalFocused } from "../lib/terminalFocus";
import { newCommandId, newProjectId } from "../lib/utils";
import { buildExplicitExecutionTargets } from "../lib/providerExecutionTargets";
import { getDefaultModelSelection } from "../models/provider/provider.models";
import { resolveShortcutCommand } from "../models/keybindings";
import { readNativeApi } from "../rpc/nativeApi";
import { useServerProviders } from "../rpc/serverState";
import { selectThreadTerminalState } from "../stores/terminal";
import { useTerminalStateStore } from "../stores/terminal";
import { useThreadSelectionStore } from "../stores/thread";
import { useCommandPaletteStore, useSearchStore } from "../stores/ui";
import { closeBrowserPanel, toggleBrowserPanel } from "~/stores/browser/browserPanel.actions";
import { closeFilesPanel, toggleFilesPanel } from "~/stores/files/filesPanel.coordinator";
import { toggleGitPanel } from "~/stores/git/gitPanel.coordinator";
import { toggleNotesPanel } from "~/stores/notes/notesPanel.coordinator";
import { closeTerminalPanel } from "~/stores/terminal/terminalPanel.coordinator";
import { useRightPanelTabsStore } from "~/stores/rightPanel/rightPanelTabs.store";
import { toastManager } from "~/components/ui/toast";
import { resolveSidebarNewThreadEnvMode } from "~/components/sidebar/Sidebar.logic";
import { useSidebar } from "~/components/ui/sidebar";
import { useSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "~/rpc/serverState";
import { SearchPalette } from "~/components/layout/SearchPalette";
import { RightPanelHost } from "~/components/right-panel/RightPanelHost";
import { isAutomationRoute } from "~/lib/automationRoute";
import { useStore } from "~/stores/main";
import { navigateToMostRecentThread } from "./-_chat.automationRightPanel.logic";

function deriveProjectTitleFromCwd(cwd: string): string {
  const trimmed = cwd.trim();
  const segments = trimmed.split(/[/\\]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? trimmed;
}

interface ChatRouteGlobalShortcutsProps {
  onToggleSearch: () => void;
}

function ChatRouteGlobalShortcuts({ onToggleSearch }: ChatRouteGlobalShortcutsProps) {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadIdsSize = useThreadSelectionStore((state) => state.selectedThreadIds.size);
  const { activeDraftThread, activeThread, defaultProjectId, handleNewThread, routeThreadId } =
    useHandleNewThread();
  const keybindings = useServerKeybindings();
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadId
      ? selectThreadTerminalState(state.terminalStateByThreadId, routeThreadId).terminalOpen
      : false,
  );
  const appSettings = useSettings();
  const { toggleSidebar } = useSidebar();
  const commandPaletteOpen = useCommandPaletteStore((state) => state.open);
  const navigate = useNavigate();
  const location = useLocation();
  const serverProviders = useServerProviders();
  const threads = useStore((state) => state.threads);

  const exitAutomationForRightPanel = useCallback(
    (openPanel: () => void) => {
      void navigateToMostRecentThread({
        navigate,
        sortOrder: appSettings.sidebarThreadSortOrder,
        threads,
      }).then(openPanel);
    },
    [navigate, appSettings.sidebarThreadSortOrder, threads],
  );

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      if (commandPaletteOpen) return;

      if (event.key === "Escape" && selectedThreadIdsSize > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });

      if (command === "sidebar.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleSidebar();
        return;
      }

      if (command === "chat.newLocal") {
        const projectId =
          activeThread?.projectId ?? activeDraftThread?.projectId ?? defaultProjectId ?? null;
        if (!projectId) return;
        event.preventDefault();
        event.stopPropagation();
        void handleNewThread(projectId, {
          envMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
        });
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        const projectId =
          activeThread?.projectId ?? activeDraftThread?.projectId ?? defaultProjectId ?? null;
        const targetProjectId =
          projectId && !isBuiltInChatsProject(projectId)
            ? BUILT_IN_CHATS_PROJECT_ID
            : (projectId ?? BUILT_IN_CHATS_PROJECT_ID);
        void handleNewThread(
          targetProjectId,
          isBuiltInChatsProject(targetProjectId)
            ? resolveNewChatOptions()
            : resolveContextualNewThreadOptions({ activeDraftThread, activeThread }),
        );
        return;
      }

      if (command === "search.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleSearch();
        return;
      }

      if (command === "browser.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleBrowserPanel();
        return;
      }

      if (command === "files.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleFilesPanel();
        return;
      }

      if (command === "git.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleGitPanel();
        return;
      }

      if (command === "notes.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleNotesPanel();
        return;
      }

      if (command === "project.open") {
        event.preventDefault();
        event.stopPropagation();
        void (async () => {
          const api = readNativeApi();
          if (!api) return;
          const pickedPath = await api.dialogs.pickFolder();
          if (!pickedPath) return;
          try {
            const executionTargets = buildExplicitExecutionTargets({
              workspaceExecutionTargetId: "local",
              providerRuntimeLocation: "local",
            });
            await api.orchestration.dispatchCommand({
              type: "project.create",
              commandId: newCommandId(),
              projectId: newProjectId(),
              title: deriveProjectTitleFromCwd(pickedPath),
              ...executionTargets,
              workspaceRoot: pickedPath,
              defaultModelSelection: getDefaultModelSelection(serverProviders),
              createdAt: new Date().toISOString(),
            });
          } catch (error) {
            toastManager.add({
              type: "error",
              title: "Failed to open project",
              description: error instanceof Error ? error.message : "An error occurred.",
            });
          }
        })();
        return;
      }

      if (command === "rightPanel.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (isAutomationRoute(location.pathname)) {
          const rightPanelState = useRightPanelTabsStore.getState();
          if (!rightPanelState.rightPanelOpen) {
            exitAutomationForRightPanel(() => {
              useRightPanelTabsStore.getState().openRightPanel();
            });
            return;
          }
        }
        useRightPanelTabsStore.getState().toggleRightPanel();
        return;
      }

      if (command === "rightPanel.newTab") {
        event.preventDefault();
        event.stopPropagation();
        if (isAutomationRoute(location.pathname)) {
          exitAutomationForRightPanel(() => {
            useRightPanelTabsStore.getState().showLauncher();
          });
          return;
        }
        useRightPanelTabsStore.getState().showLauncher();
        return;
      }

      if (command === "settings.toggle") {
        event.preventDefault();
        event.stopPropagation();
        closeBrowserPanel();
        closeFilesPanel();
        closeTerminalPanel();
        void navigate({ to: "/settings" });
        return;
      }
    };

    window.addEventListener("keydown", onWindowKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, { capture: true });
    };
  }, [
    activeDraftThread,
    activeThread,
    clearSelection,
    handleNewThread,
    keybindings,
    defaultProjectId,
    selectedThreadIdsSize,
    terminalOpen,
    appSettings.defaultThreadEnvMode,
    commandPaletteOpen,
    toggleSidebar,
    navigate,
    onToggleSearch,
    serverProviders,
    location.pathname,
    exitAutomationForRightPanel,
  ]);

  return null;
}

function ChatRouteLayout() {
  const { routeThreadId } = useHandleNewThread();
  const toggleSearchOpen = useSearchStore((state) => state.toggleSearchOpen);

  return (
    <>
      <ChatRouteGlobalShortcuts onToggleSearch={toggleSearchOpen} />
      <SearchPalette activeThreadId={routeThreadId ?? null} />
      <Outlet />
      <RightPanelHost activeThreadId={routeThreadId ?? null} />
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
