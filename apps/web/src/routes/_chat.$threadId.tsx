import { ThreadId } from "@bigbud/contracts";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import ChatView from "../components/chat/view/ChatView";
import { useComposerDraftStore } from "../stores/composer";
import { closeDiffRouteSearch, type DiffRouteSearch, parseDiffRouteSearch } from "../utils/diff";
import { usePageTitle } from "../hooks/usePageTitle";
import { isVisibleThread } from "../logic/thread/threadVisibility.logic";
import { type ThreadHydration, useStore } from "../stores/main";
import { SidebarInset } from "~/components/ui/sidebar";
import { registerDiffPanelCloseAction } from "../stores/rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "../stores/rightPanel/rightPanelTabs.store";
import { readNativeApi } from "../rpc/nativeApi";
import { hydrateSelectedThread, runBoundedBootstrap } from "./-__root.bounded-bootstrap";

export function getMissingThreadRouteAction(input: {
  bootstrapComplete: boolean;
  routeThreadExists: boolean;
  hydrationStatus: ThreadHydration["status"];
}): "bootstrap" | "redirect" | null {
  if (!input.bootstrapComplete || input.routeThreadExists) {
    return null;
  }
  if (input.hydrationStatus === "unloaded") {
    return "bootstrap";
  }
  return input.hydrationStatus === "failed" ? "redirect" : null;
}

export function ChatThreadRouteView() {
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const navigate = useNavigate();
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const routeThread = useStore((store) => store.threads.find((thread) => thread.id === threadId));
  const hydrationStatus = useStore(
    (store) => store.threadHydrationById[threadId]?.status ?? "unloaded",
  );
  const threadTitle =
    routeThread && isVisibleThread(routeThread) ? routeThread.title : "New thread";
  const search = Route.useSearch();
  const draftThreadExists = useComposerDraftStore((store) =>
    Object.hasOwn(store.draftThreadsByThreadId, threadId),
  );
  const routeThreadExists = routeThread ? isVisibleThread(routeThread) : draftThreadExists;
  const missingThreadRouteAction = getMissingThreadRouteAction({
    bootstrapComplete,
    routeThreadExists,
    hydrationStatus,
  });
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
    const api = readNativeApi();
    if (!api || !bootstrapComplete || !routeThread || hydrationStatus !== "unloaded") {
      return;
    }
    void hydrateSelectedThread({ api, threadId });
  }, [bootstrapComplete, hydrationStatus, routeThread, threadId]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api || missingThreadRouteAction !== "bootstrap") {
      return;
    }

    let disposed = false;
    void runBoundedBootstrap({ api, selectedThreadId: threadId, disposed: () => disposed }).catch(
      () => undefined,
    );
    return () => {
      disposed = true;
    };
  }, [missingThreadRouteAction, threadId]);

  useEffect(() => {
    if (missingThreadRouteAction === "redirect") {
      void navigate({ to: "/", replace: true });
    }
  }, [missingThreadRouteAction, navigate]);

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
