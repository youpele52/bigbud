import { ThreadId } from "@bigbud/contracts";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import ChatView from "../components/chat/view/ChatView";
import DiffPanel from "../components/diff/DiffPanel";
import { DiffWorkerPoolProvider } from "../components/diff/DiffWorkerPoolProvider";
import { useComposerDraftStore } from "../stores/composer";
import { closeDiffRouteSearch, type DiffRouteSearch, parseDiffRouteSearch } from "../utils/diff";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { usePageTitle } from "../hooks/usePageTitle";
import { useStore } from "../stores/main";
import { Sheet, SheetPopup } from "../components/ui/sheet";
import { SidebarInset } from "~/components/ui/sidebar";
import { registerDiffPanelCloseAction } from "../stores/rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "../stores/rightPanel/rightPanelTabs.store";

const DIFF_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 1180px)";

const DiffPanelSheet = (props: {
  children: ReactNode;
  diffOpen: boolean;
  onCloseDiff: () => void;
}) => {
  return (
    <Sheet
      open={props.diffOpen}
      onOpenChange={(open) => {
        if (!open) {
          props.onCloseDiff();
        }
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        className="w-[min(88vw,820px)] max-w-[820px] p-0"
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
};

const DeferredDiffPanel = (props: { mode: "sheet" }) => {
  return (
    <DiffWorkerPoolProvider>
      <DiffPanel mode={props.mode} />
    </DiffWorkerPoolProvider>
  );
};

function ChatThreadRouteView() {
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const navigate = useNavigate();
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const threadTitle = useStore(
    (store) => store.threads.find((thread) => thread.id === threadId)?.title ?? "New thread",
  );
  const search = Route.useSearch();
  const threadExists = useStore((store) => store.threads.some((thread) => thread.id === threadId));
  const draftThreadExists = useComposerDraftStore((store) =>
    Object.hasOwn(store.draftThreadsByThreadId, threadId),
  );
  const routeThreadExists = threadExists || draftThreadExists;
  const diffOpen = search.diff === "1";
  const shouldUseDiffSheet = useMediaQuery(DIFF_INLINE_LAYOUT_MEDIA_QUERY);
  usePageTitle(threadTitle);

  const [hasOpenedDiff, setHasOpenedDiff] = useState(diffOpen);

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
      setHasOpenedDiff(true);
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

  const shouldRenderDiffContent = diffOpen || hasOpenedDiff;

  return (
    <>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <ChatView threadId={threadId} />
      </SidebarInset>
      {shouldUseDiffSheet && (
        <DiffPanelSheet diffOpen={diffOpen} onCloseDiff={closeDiff}>
          {shouldRenderDiffContent ? <DeferredDiffPanel mode="sheet" /> : null}
        </DiffPanelSheet>
      )}
    </>
  );
}

export const Route = createFileRoute("/_chat/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  search: {
    middlewares: [retainSearchParams<DiffRouteSearch>(["diff"])],
  },
  component: ChatThreadRouteView,
});
