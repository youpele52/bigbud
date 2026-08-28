import { ThreadId, type GetThreadOwnershipResult } from "@bigbud/contracts";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import ChatView from "../components/chat/view/ChatView";
import { BigbudLogo } from "../components/sidebar/SidebarProjectItem";
import {
  clearPromotedDraftThread,
  replaceCollidingDraftThreadLocally,
  useComposerDraftStore,
} from "../stores/composer";
import { closeDiffRouteSearch, type DiffRouteSearch, parseDiffRouteSearch } from "../utils/diff";
import { usePageTitle } from "../hooks/usePageTitle";
import { isVisibleThread } from "../logic/thread/threadVisibility.logic";
import { type ThreadHydration, useStore } from "../stores/main";
import { SidebarInset } from "~/components/ui/sidebar";
import { registerDiffPanelCloseAction } from "../stores/rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "../stores/rightPanel/rightPanelTabs.store";
import { readNativeApi } from "../rpc/nativeApi";
import { hydrateSelectedThread, runBoundedBootstrap } from "./-__root.bounded-bootstrap";
import { toastManager } from "../components/ui/toast";
import { createOwnershipReplacementThreadId } from "../hooks/useHandleNewThread.ownership";

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

export function isConfirmedLocalDraftThread(
  draftThreadExists: boolean,
  ownership: GetThreadOwnershipResult | null,
): boolean {
  return draftThreadExists && ownership?.status === "absent";
}

export function getCanonicalCollisionNavigation(ownership: GetThreadOwnershipResult) {
  return ownership.status === "archived"
    ? ({ to: "/settings/archived", search: { threadId: ownership.threadId } } as const)
    : ({ to: "/" } as const);
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
  const [draftOwnership, setDraftOwnership] = useState<GetThreadOwnershipResult | null>(null);
  const resolvingDraftOwnership = draftThreadExists && routeThread === undefined;
  const routeThreadExists = routeThread
    ? isVisibleThread(routeThread)
    : isConfirmedLocalDraftThread(draftThreadExists, draftOwnership);
  const missingThreadRouteAction = getMissingThreadRouteAction({
    bootstrapComplete,
    routeThreadExists,
    hydrationStatus: resolvingDraftOwnership ? "loading" : hydrationStatus,
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
    if (!bootstrapComplete || !resolvingDraftOwnership) {
      return;
    }
    const api = readNativeApi();
    if (!api) {
      setDraftOwnership({
        threadId,
        status: "unavailable",
        ownership: "unconfirmed",
        reason: "bigbud is not connected to the server.",
      });
      return;
    }

    let disposed = false;
    void (async () => {
      try {
        const ownership = await api.orchestration.resolveThreadOwnership({ threadId });
        if (disposed) return;
        setDraftOwnership(ownership);
        if (ownership.status === "absent" || ownership.status === "unavailable") return;
        if (ownership.status === "active") {
          clearPromotedDraftThread(threadId);
          await hydrateSelectedThread({ api, threadId });
          return;
        }

        const draft = useComposerDraftStore.getState().getDraftThread(threadId);
        if (draft) {
          replaceCollidingDraftThreadLocally({
            threadId,
            nextThreadId: await createOwnershipReplacementThreadId(ownership),
            projectId: draft.projectId,
            createdAt: new Date().toISOString(),
          });
        }
        if (disposed) return;
        toastManager.add({
          type: "info",
          title: ownership.status === "archived" ? "Thread is archived" : "Thread is unavailable",
          description:
            ownership.status === "archived"
              ? "This saved thread is owned by the server and cannot be created again."
              : ownership.status === "deleted"
                ? "This thread was deleted and its saved draft was moved to a fresh chat."
                : "This thread is being removed and cannot be reused as a new draft.",
        });
        const collisionNavigation = getCanonicalCollisionNavigation(ownership);
        if (collisionNavigation.to === "/settings/archived") {
          await hydrateSelectedThread({ api, threadId });
          if (disposed) return;
          await navigate({
            to: "/settings/archived",
            search: collisionNavigation.search,
            replace: true,
          });
          return;
        }
        await navigate({ to: "/", replace: true });
      } catch (error) {
        if (disposed) return;
        setDraftOwnership({
          threadId,
          status: "unavailable",
          ownership: "unconfirmed",
          reason:
            error instanceof Error ? error.message : "Canonical ownership could not be checked.",
        });
      }
    })();
    return () => {
      disposed = true;
    };
  }, [bootstrapComplete, navigate, resolvingDraftOwnership, threadId]);

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
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <div className="flex h-full items-center justify-center">
          {draftOwnership?.status === "unavailable" ? (
            <p className="max-w-sm px-6 text-center text-sm text-muted-foreground">
              Your draft is safe. Reconnect to verify this thread before sending.
            </p>
          ) : (
            <BigbudLogo className="h-7 animate-breathe text-muted-foreground/40 motion-reduce:animate-none" />
          )}
        </div>
      </SidebarInset>
    );
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
