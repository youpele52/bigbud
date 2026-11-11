import { useEffect, useRef } from "react";
import { useParams } from "@tanstack/react-router";
import { isBuiltInChatsProject } from "@bigbud/contracts/constants/project.constant";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { SidebarThreadSummary } from "../../models/types";
import { useUiStateStore } from "../../stores/ui";
import { useInyosiraStore } from "../../stores/inyosira/inyosira.store";
import { useSidebar } from "../ui/sidebar";
import { useThreadRenameRequest } from "./Sidebar.threadRenameRequest";

/** Reveal the existing row; active-thread previews already retain it beyond the preview limit. */
export function revealThreadForRename(thread: SidebarThreadSummary) {
  const ui = useUiStateStore.getState();
  if (isBuiltInChatsProject(thread.projectId)) ui.setChatsExpanded(true);
  else {
    ui.setProjectsExpanded(true);
    ui.setRemoteWorkspacesExpanded(true);
    ui.setProjectExpanded(thread.projectId, true);
  }
  useInyosiraStore.getState().setStateCollapsed(thread.organization?.state ?? "present", false);
}

export function useSidebarThreadRenameRequest(input: {
  readonly sidebarThreadsById: Record<ThreadId, SidebarThreadSummary | undefined>;
  readonly navigateToThreadRoute: (threadId: ThreadId) => void | Promise<boolean>;
  readonly startRename: (thread: SidebarThreadSummary) => void;
}) {
  const { threadId: requested, requestId, expiresAt } = useThreadRenameRequest();
  const attempted = useRef<number | null>(null);
  const routeThreadId = useParams({ strict: false }).threadId;
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  useEffect(() => {
    if (!requested) {
      attempted.current = null;
      return;
    }
    const consume = () => useThreadRenameRequest.getState().consume(requestId);
    // Also check wall time: background tabs can throttle the store-owned expiration timer.
    if (Date.now() >= expiresAt) {
      consume();
      return;
    }
    const thread = input.sidebarThreadsById[requested];
    // A summary arriving on the next snapshot can fulfill the same bounded request.
    if (!thread) return;
    if (thread.archivedAt || thread.deletingAt) {
      consume();
      return;
    }
    if (routeThreadId !== requested) {
      if (attempted.current !== requestId) {
        attempted.current = requestId;
        // This is the sidebar's existing remote-access-gated navigation, not a raw router call.
        try {
          void Promise.resolve(input.navigateToThreadRoute(requested)).then((accepted) => {
            if (accepted === false) consume();
          }, consume);
        } catch {
          consume();
        }
      }
      return;
    }
    revealThreadForRename(thread);
    if (isMobile) setOpenMobile(true);
    else setOpen(true);
    input.startRename(thread);
    consume();
  }, [requested, requestId, expiresAt, routeThreadId, input, isMobile, setOpen, setOpenMobile]);
}
