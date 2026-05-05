import { BUILT_IN_CHATS_PROJECT_ID, isBuiltInChatsProject } from "@bigbud/contracts";
import { Outlet, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import {
  resolveContextualNewThreadOptions,
  resolveNewChatOptions,
  useHandleNewThread,
} from "../hooks/useHandleNewThread";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveShortcutCommand } from "../models/keybindings";
import { selectThreadTerminalState } from "../stores/terminal";
import { useTerminalStateStore } from "../stores/terminal";
import { useThreadSelectionStore } from "../stores/thread";
import { useCommandPaletteStore, useSearchStore } from "../stores/ui";
import { resolveSidebarNewThreadEnvMode } from "~/components/sidebar/Sidebar.logic";
import { useSidebar } from "~/components/ui/sidebar";
import { useSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "~/rpc/serverState";
import { SearchPalette } from "~/components/layout/SearchPalette";
import { closeBrowserPanel, toggleBrowserPanel } from "~/stores/browser/browserPanel.coordinator";
import BrowserPanel from "~/components/browser/BrowserPanel";

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

      if (command === "settings.toggle") {
        event.preventDefault();
        event.stopPropagation();
        closeBrowserPanel();
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
      <BrowserPanel activeThreadId={routeThreadId ?? null} />
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
