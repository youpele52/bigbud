import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useRightPanelCloseTabShortcut } from "~/stores/rightPanel/useRightPanelCloseTabShortcut";
import { useStore } from "~/stores/main";

import ThreadSidebar from "../sidebar/Sidebar";
import {
  getBrowserPanelPlaceholderWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH_PX,
} from "./chatLayout.shared";
import { Sidebar, SidebarProvider, SidebarRail } from "../ui/sidebar";
import { isThreadNavigationAvailable, parseOpenThreadAction } from "./AppSidebarLayout.logic";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
const THREAD_SIDEBAR_MAX_WIDTH = 30 * 16;

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const bootstrapComplete = useStore((state) => state.bootstrapComplete);
  const threads = useStore((state) => state.threads);
  const sidebarThreadsById = useStore((state) => state.sidebarThreadsById);
  const [pendingThreadId, setPendingThreadId] = useState<string | null>(null);
  useRightPanelCloseTabShortcut();

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (typeof action !== "string") return;
      if (action === "open-settings") {
        void navigate({ to: "/settings" });
        return;
      }
      const threadId = parseOpenThreadAction(action);
      if (threadId) {
        setPendingThreadId(threadId);
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  useEffect(() => {
    if (!pendingThreadId || !bootstrapComplete) return;

    const threadId = pendingThreadId;
    setPendingThreadId(null);
    if (!isThreadNavigationAvailable(threadId, { threads, sidebarThreadsById })) return;

    void navigate({ to: "/$threadId", params: { threadId } });
  }, [bootstrapComplete, navigate, pendingThreadId, sidebarThreadsById, threads]);

  return (
    <SidebarProvider defaultOpen>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-[var(--app-shell-sidebar-background)] text-foreground"
        resizable={{
          maxWidth: THREAD_SIDEBAR_MAX_WIDTH,
          minWidth: THREAD_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ nextWidth, wrapper }) =>
            wrapper.clientWidth - nextWidth - getBrowserPanelPlaceholderWidth() >=
            THREAD_MAIN_CONTENT_MIN_WIDTH_PX,
          storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <ThreadSidebar />
        <SidebarRail />
      </Sidebar>
      {children}
    </SidebarProvider>
  );
}
