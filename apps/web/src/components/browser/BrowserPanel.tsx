import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { DesktopCertificateChallenge } from "@bigbud/contracts/server/ipc.desktopCertificate.ts";

import { randomUUID } from "~/lib/utils";
import { isElectron } from "~/config/env";
import { useComposerDraftStore } from "~/stores/composer";
import { normalizeAnnotationComment } from "~/stores/composer/types.annotation.store";
import { toastManager } from "../ui/toast";
import { useBrowserPanelStore } from "../../stores/browser/browser.store";
import { closeBrowserTab, openNewBrowserTab } from "../../stores/browser/browserPanel.actions";
import { dataUrlToFile } from "./BrowserPanel.annotation";
import { cropBrowserAnnotationImage } from "./BrowserPanel.annotation.image";
import {
  BrowserViewport,
  type BrowserPageMetadata,
  type BrowserViewportRef,
} from "./BrowserPanel.viewport";
import { BrowserToolbar } from "./BrowserPanel.toolbar";
import { BrowserContextMenu, type ContextMenuItem } from "./BrowserPanel.contextMenu";
import { useBrowserContextMenu } from "./BrowserPanel.contextMenu.hook";
import { waitForVisibleBrowserNavigation } from "./BrowserPanel.agentNavigation";
import {
  executeBrowserTabActionWhenReady,
  registerBrowserTabAgentHandler,
} from "./browserAgentControl";
import { getBrowserHistory, recordBrowserHistoryUrl } from "./BrowserPanel.history";
import { planDesktopBrowserContextMenu, planDesktopBrowserReload } from "./BrowserPanel.menuAction";
import { reloadBrowserViewport } from "./BrowserPanel.reload";
import { createBrowserContextMenuItems } from "./BrowserPanel.contextMenuItems";
import { BigbudLogo } from "../sidebar/SidebarProjectItem";
import { BrowserAgentCursor } from "./BrowserPanel.agentCursor";
import { BrowserAgentStatus } from "./BrowserPanel.agentStatus";
import type { BrowserLoadFailure } from "./BrowserPanel.navigationError";
import { BrowserPanelNavigationErrorPage } from "./BrowserPanel.navigationErrorPage";
import type { BrowserPanelProps } from "./BrowserPanel.types";

export const BrowserPanelContent = memo(function BrowserPanelContent({
  activeThreadId,
  tabId = "browser",
  visible = true,
}: BrowserPanelProps) {
  const open = useBrowserPanelStore((state) => state.open);
  const url = useBrowserPanelStore((state) => state.tabsById[tabId]?.url ?? "");
  const agentLease = useBrowserPanelStore((state) => state.tabsById[tabId]?.agentLease);
  const agentCursor = useBrowserPanelStore((state) => state.tabsById[tabId]?.agentCursor);
  const agentHandoff = useBrowserPanelStore((state) => state.tabsById[tabId]?.agentHandoff);
  const ensureTab = useBrowserPanelStore((state) => state.ensureTab);
  const setTabTitle = useBrowserPanelStore((state) => state.setTabTitle);
  const setTabUrl = useBrowserPanelStore((state) => state.setTabUrl);
  const addComposerImage = useComposerDraftStore((state) => state.addImage);
  const addComposerAnnotation = useComposerDraftStore((state) => state.addAnnotation);
  const [inputUrl, setInputUrl] = useState(url);
  const viewportRef = useRef<BrowserViewportRef>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loadError, setLoadError] = useState<BrowserLoadFailure | null>(null);
  const [certificateChallenge, setCertificateChallenge] =
    useState<DesktopCertificateChallenge | null>(null);
  const [pageMetadata, setPageMetadata] = useState<BrowserPageMetadata>({
    title: "",
    faviconUrl: null,
  });
  const [annotationActive, setAnnotationActive] = useState(false);
  const [browserHistory, setBrowserHistory] = useState(() => getBrowserHistory());
  const contextMenu = useBrowserContextMenu(visible && Boolean(url.trim()));
  const closeContextMenu = contextMenu.close;
  const toggleContextMenuCentered = contextMenu.toggleCentered;
  const [queuedDesktopReload, setQueuedDesktopReload] = useState<
    "normal" | "ignoring-cache" | null
  >(null);

  useEffect(() => {
    ensureTab(tabId, url);
  }, [ensureTab, tabId, url]);

  useEffect(
    () =>
      registerBrowserTabAgentHandler(tabId, {
        execute: async (action) => {
          if (action.action === "navigate") {
            setInputUrl(action.url);
            setTabUrl(tabId, action.url);
            setBrowserHistory(recordBrowserHistoryUrl(action.url));
            const pageResult = await waitForVisibleBrowserNavigation({
              url: action.url,
              viewportRef,
            });
            return {
              ...pageResult,
              action: action.action,
              summary: `Navigated visible browser to ${action.url}.`,
            };
          }
          return executeBrowserTabActionWhenReady(() => {
            const viewport = viewportRef.current;
            if (!viewport) {
              throw new Error("The visible browser tab is not ready.");
            }
            return viewport.executeAgentAction(action);
          });
        },
      }),
    [setTabUrl, tabId],
  );

  useEffect(() => {
    setTabTitle(tabId, pageMetadata.title.trim());
  }, [pageMetadata.title, setTabTitle, tabId]);

  const reloadViewport = useCallback(
    (mode: "normal" | "ignoring-cache") => reloadBrowserViewport(viewportRef, mode),
    [],
  );

  const handleNavigate = useCallback(() => {
    let nextUrl = inputUrl.trim();
    if (!nextUrl) return;
    if (!/^https?:\/\//i.test(nextUrl)) {
      nextUrl = `https://${nextUrl}`;
    }
    setInputUrl(nextUrl);
    setLoadError(null);
    setTabUrl(tabId, nextUrl);
    setBrowserHistory(recordBrowserHistoryUrl(nextUrl));
  }, [inputUrl, setTabUrl, tabId]);

  const handleSelectHistoryUrl = useCallback(
    (nextUrl: string) => {
      setInputUrl(nextUrl);
      setLoadError(null);
      setTabUrl(tabId, nextUrl);
      setBrowserHistory(recordBrowserHistoryUrl(nextUrl));
    },
    [setTabUrl, tabId],
  );

  const handleCancelEmptyUrlEdit = useCallback(() => {
    setInputUrl(url);
  }, [url]);

  const handleUrlChange = useCallback(
    (nextUrl: string) => {
      setInputUrl(nextUrl);
      setLoadError(null);
      setTabUrl(tabId, nextUrl);
      setBrowserHistory(recordBrowserHistoryUrl(nextUrl));
    },
    [setTabUrl, tabId],
  );

  const handleClose = useCallback(() => {
    if (annotationActive) {
      void viewportRef.current?.cancelAnnotation();
      setAnnotationActive(false);
    }
    closeBrowserTab(tabId);
  }, [annotationActive, tabId]);

  const handleOpenInExternalBrowser = useCallback(() => {
    const externalUrl = url.trim();
    if (!externalUrl) return;

    if (window.desktopBridge) {
      void window.desktopBridge.openExternal(externalUrl);
      return;
    }

    window.open(externalUrl, "_blank", "noopener,noreferrer");
  }, [url]);

  const handleAnnotate = useCallback(async () => {
    if (annotationActive) {
      await viewportRef.current?.cancelAnnotation();
      setAnnotationActive(false);
      return;
    }

    if (!activeThreadId) {
      toastManager.add({ type: "error", title: "Open a thread before annotating." });
      return;
    }

    setAnnotationActive(true);
    try {
      const annotation = await viewportRef.current?.startAnnotation();
      setAnnotationActive(false);
      if (!annotation) return;

      const screenshotDataUrl =
        (await cropBrowserAnnotationImage({
          dataUrl: annotation.screenshot.dataUrl,
          element: annotation.element,
          viewport: annotation.viewport,
        })) ?? annotation.screenshot.dataUrl;

      const file = dataUrlToFile(
        screenshotDataUrl,
        "browser-annotation.png",
        annotation.screenshot.mime,
      );
      if (!file) {
        toastManager.add({ type: "error", title: "Could not capture browser screenshot." });
        return;
      }

      const previewUrl = URL.createObjectURL(file);
      const imageId = randomUUID();
      addComposerImage(activeThreadId, {
        type: "image",
        id: imageId,
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl,
        file,
      });
      addComposerAnnotation(activeThreadId, {
        id: randomUUID(),
        imageId,
        comment: normalizeAnnotationComment(annotation.comment),
        intent: annotation.intent,
        page: annotation.page,
        element: annotation.element,
        viewport: annotation.viewport,
        createdAt: new Date().toISOString(),
      });
      toastManager.add({
        type: "success",
        title: "Annotation added to composer",
        data: { threadId: activeThreadId, dismissAfterVisibleMs: 3000 },
      });
    } catch (error) {
      setAnnotationActive(false);
      toastManager.add({
        type: "error",
        title: "Browser annotation failed",
        description: error instanceof Error ? error.message : String(error),
        data: { threadId: activeThreadId },
      });
    }
  }, [activeThreadId, addComposerAnnotation, addComposerImage, annotationActive]);

  useEffect(() => {
    if (!open && annotationActive) {
      void viewportRef.current?.cancelAnnotation();
      setAnnotationActive(false);
    }
  }, [annotationActive, open]);

  useEffect(() => {
    const nextUrl = url.trim();
    if (!nextUrl) return;
    setInputUrl(nextUrl);
  }, [url]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (typeof action !== "string") return;
      const contextMenuCommand = planDesktopBrowserContextMenu({
        action,
        browserVisible: visible,
        hasUrl: Boolean(url.trim()),
      });
      if (contextMenuCommand) {
        if (contextMenuCommand === "toggle") {
          toggleContextMenuCentered();
        } else {
          closeContextMenu();
        }
        return;
      }

      const reloadPlan = planDesktopBrowserReload({
        action,
        browserOpen: open,
        browserVisible: visible,
      });
      if (!reloadPlan.reloadMode) {
        return;
      }

      if (reloadPlan.shouldActivateBrowser) {
        setQueuedDesktopReload(reloadPlan.reloadMode);
        return;
      }

      reloadViewport(reloadPlan.reloadMode);
    });

    return () => {
      unsubscribe?.();
    };
  }, [closeContextMenu, open, reloadViewport, toggleContextMenuCentered, url, visible]);

  useEffect(() => {
    if (!queuedDesktopReload) {
      return;
    }

    reloadViewport(queuedDesktopReload);
    setQueuedDesktopReload(null);
  }, [queuedDesktopReload, reloadViewport]);

  const contextMenuItems: ContextMenuItem[] = createBrowserContextMenuItems({
    canGoBack,
    canGoForward,
    context: contextMenu.context,
    currentUrl: url,
    activeThreadId,
    viewportRef,
    onOpenNewTab: (nextUrl) => openNewBrowserTab({ url: nextUrl }),
  });
  const isAgentControlled = agentLease !== undefined;
  return (
    <>
      <BrowserToolbar
        inputUrl={inputUrl}
        setInputUrl={setInputUrl}
        onNavigate={handleNavigate}
        onSelectHistoryUrl={handleSelectHistoryUrl}
        onCancelEmptyUrlEdit={handleCancelEmptyUrlEdit}
        onClose={handleClose}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onGoBack={() => viewportRef.current?.goBack()}
        onGoForward={() => viewportRef.current?.goForward()}
        onReload={() => viewportRef.current?.reload()}
        onOpenInExternalBrowser={handleOpenInExternalBrowser}
        onAnnotate={handleAnnotate}
        annotationActive={annotationActive}
        pageMetadata={pageMetadata}
        historyUrls={browserHistory}
        annotationDisabled={!isElectron || !url.trim()}
        agentControlled={isAgentControlled}
      />
      <BrowserAgentStatus tabId={tabId} controlled={isAgentControlled} handoff={agentHandoff} />
      <div
        ref={contextMenu.boundaryRef}
        className={
          isAgentControlled
            ? "pointer-events-none relative min-h-0 flex-1"
            : "relative min-h-0 flex-1"
        }
      >
        {isAgentControlled ? <BrowserAgentCursor cursor={agentCursor} /> : null}
        {!url.trim() ? (
          <div className="flex h-full items-center justify-center">
            <BigbudLogo className="h-8 text-muted-foreground/30" />
          </div>
        ) : (
          <>
            <BrowserViewport
              ref={viewportRef}
              url={url}
              onUrlChange={handleUrlChange}
              onNavigationStateChange={({ canGoBack: back, canGoForward: forward }) => {
                setCanGoBack(back);
                setCanGoForward(forward);
              }}
              onLoadStart={() => setLoadError(null)}
              onLoadSuccess={() => setLoadError(null)}
              onLoadFail={setLoadError}
              onCertificateChallengeChange={setCertificateChallenge}
              onPageMetadataChange={setPageMetadata}
              onContextMenu={isElectron ? contextMenu.openAtHostPoint : undefined}
            />
            <BrowserPanelNavigationErrorPage
              failure={loadError}
              certificateChallenge={certificateChallenge}
              agentControlled={isAgentControlled}
              onReload={() => viewportRef.current?.reload()}
              onGoBack={canGoBack ? () => viewportRef.current?.goBack() : undefined}
            />
            <BrowserContextMenu
              anchor={contextMenu.anchor}
              items={contextMenuItems}
              onClose={contextMenu.close}
            />
          </>
        )}
      </div>
    </>
  );
});

const BrowserPanel = memo(function BrowserPanel(props: BrowserPanelProps) {
  return <BrowserPanelContent {...props} />;
});

export default BrowserPanel;
