import { ThreadId } from "@bigbud/contracts";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import ChatView from "../components/chat/view/ChatView";
import { useComposerDraftStore } from "../stores/composer";
import { closeDiffRouteSearch, type DiffRouteSearch, parseDiffRouteSearch } from "../utils/diff";
import { usePageTitle } from "../hooks/usePageTitle";
import { isVisibleThread } from "../logic/thread/threadVisibility.logic";
import { useStore } from "../stores/main";
import { SidebarInset } from "~/components/ui/sidebar";
import { registerDiffPanelCloseAction } from "../stores/rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "../stores/rightPanel/rightPanelTabs.store";

export function ChatThreadRouteView() {
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const navigate = useNavigate();
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const routeThread = useStore((store) => store.threads.find((thread) => thread.id === threadId));
  const threadTitle =
    routeThread && isVisibleThread(routeThread) ? routeThread.title : "New thread";
  const search = Route.useSearch();
  const draftThreadExists = useComposerDraftStore((store) =>
    Object.hasOwn(store.draftThreadsByThreadId, threadId),
  );
  const routeThreadExists = routeThread ? isVisibleThread(routeThread) : draftThreadExists;
  const diffOpen = search.diff === "1";
  usePageTitle(threadTitle);

  const closeDiff = useCallback(() => {
    useRightPanelTabsStore.getState().closeTab("diff");

    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => closeDiffRouteSearch(previous),
    });
  }, [navigate, threadId]);

  // Sync diff URL state with right panel tab store
  useEffect(() => {
    if (diffOpen) {
      useRightPanelTabsStore.getState().ensureTabOpen("diff");
    } else {
      useRightPanelTabsStore.getState().closeTab("diff");
    }
  }, [diffOpen]);

  useEffect(() => registerDiffPanelCloseAction(closeDiff), [closeDiff]);

  useEffect(() => {
    if (!bootstrapComplete) {
      return;
    }

    if (!routeThreadExists) {
      void navigate({ to: "/", replace: true });
      return;
    }
  }, [bootstrapComplete, navigate, routeThreadExists]);

  if (!bootstrapComplete || !routeThreadExists) {
    return null;
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <ChatView threadId={threadId} />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  search: {
    middlewares: [retainSearchParams<DiffRouteSearch>(["diff"])],
  },
  component: ChatThreadRouteView,
});
