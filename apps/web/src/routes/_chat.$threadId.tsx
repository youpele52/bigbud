import { ThreadId } from "@bigbud/contracts";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import ChatView from "../components/chat/view/ChatView";
import DiffPanel from "../components/diff/DiffPanel";
import { DiffWorkerPoolProvider } from "../components/diff/DiffWorkerPoolProvider";
import { type DiffPanelMode } from "../components/diff/DiffPanelShell";
import { useComposerDraftStore } from "../stores/composer";
import {
  closeDiffRouteSearch,
  type DiffRouteSearch,
  openDiffRouteSearch,
  parseDiffRouteSearch,
} from "../utils/diff";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { usePageTitle } from "../hooks/usePageTitle";
import { useStore } from "../stores/main";
import { Sheet, SheetPopup } from "../components/ui/sheet";
import {
  closeBrowserPanel,
  getRequestedRightPanel,
  registerDiffPanelCloseAction,
  requestRightPanel,
} from "../stores/browser/browserPanel.coordinator";
import { useBrowserPanelStore } from "../stores/browser/browser.store";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";

const DIFF_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 1180px)";
const DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_diff_sidebar_width";
const DIFF_INLINE_DEFAULT_WIDTH = "clamp(28rem,48vw,44rem)";
const DIFF_INLINE_SIDEBAR_MIN_WIDTH = 26 * 16;
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;

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

const DeferredDiffPanel = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffWorkerPoolProvider>
      <DiffPanel mode={props.mode} />
    </DiffWorkerPoolProvider>
  );
};

const DiffPanelInlineSidebar = (props: {
  diffOpen: boolean;
  onCloseDiff: () => void;
  onOpenDiff: () => void;
  renderDiffContent: boolean;
}) => {
  const { diffOpen, onCloseDiff, onOpenDiff, renderDiffContent } = props;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onOpenDiff();
        return;
      }
      onCloseDiff();
    },
    [onCloseDiff, onOpenDiff],
  );
  const shouldAcceptInlineSidebarWidth = useCallback(
    ({ nextWidth, wrapper }: { nextWidth: number; wrapper: HTMLElement }) => {
      const composerForm = document.querySelector<HTMLElement>("[data-chat-composer-form='true']");
      if (!composerForm) return true;
      const composerViewport = composerForm.parentElement;
      if (!composerViewport) return true;
      const previousSidebarWidth = wrapper.style.getPropertyValue("--sidebar-width");
      wrapper.style.setProperty("--sidebar-width", `${nextWidth}px`);

      const viewportStyle = window.getComputedStyle(composerViewport);
      const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
      const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
      const viewportContentWidth = Math.max(
        0,
        composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
      );
      const formRect = composerForm.getBoundingClientRect();
      const composerFooter = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-footer='true']",
      );
      const composerRightActions = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-actions='right']",
      );
      const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
      const composerFooterGap = composerFooter
        ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
          Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
          0
        : 0;
      const minimumComposerWidth =
        COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
      const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
      const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
      const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;

      if (previousSidebarWidth.length > 0) {
        wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
      } else {
        wrapper.style.removeProperty("--sidebar-width");
      }

      return !hasComposerOverflow && !overflowsViewport && !violatesMinimumComposerWidth;
    },
    [],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open={diffOpen}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": DIFF_INLINE_DEFAULT_WIDTH } as React.CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          minWidth: DIFF_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        {renderDiffContent ? <DeferredDiffPanel mode="sidebar" /> : null}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
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
  const browserOpen = useBrowserPanelStore((state) => state.open);
  const shouldUseDiffSheet = useMediaQuery(DIFF_INLINE_LAYOUT_MEDIA_QUERY);
  usePageTitle(threadTitle);
  // TanStack Router keeps active route components mounted across param-only navigations
  // unless remountDeps are configured, so this stays warm across thread switches.
  const [hasOpenedDiff, setHasOpenedDiff] = useState(diffOpen);
  const closeDiff = useCallback(() => {
    if (getRequestedRightPanel() === "diff") {
      requestRightPanel(null);
    }

    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => closeDiffRouteSearch(previous),
    });
  }, [navigate, threadId]);
  const openDiff = useCallback(() => {
    requestRightPanel("diff");
    closeBrowserPanel();

    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => openDiffRouteSearch(previous),
    });
  }, [navigate, threadId]);

  useEffect(() => {
    if (diffOpen) {
      setHasOpenedDiff(true);
    }
  }, [diffOpen]);

  useEffect(() => registerDiffPanelCloseAction(closeDiff), [closeDiff]);

  useEffect(() => {
    if (!browserOpen || !diffOpen) {
      return;
    }

    if (getRequestedRightPanel() === "diff") {
      closeBrowserPanel();
      return;
    }

    closeDiff();
  }, [browserOpen, closeDiff, diffOpen]);

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

  if (!shouldUseDiffSheet) {
    return (
      <>
        <SidebarInset className="h-dvh  min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
          <ChatView threadId={threadId} />
        </SidebarInset>
        <DiffPanelInlineSidebar
          diffOpen={diffOpen}
          onCloseDiff={closeDiff}
          onOpenDiff={openDiff}
          renderDiffContent={shouldRenderDiffContent}
        />
      </>
    );
  }

  return (
    <>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <ChatView threadId={threadId} />
      </SidebarInset>
      <DiffPanelSheet diffOpen={diffOpen} onCloseDiff={closeDiff}>
        {shouldRenderDiffContent ? <DeferredDiffPanel mode="sheet" /> : null}
      </DiffPanelSheet>
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
