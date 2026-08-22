import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { DesktopCertificateChallenge } from "@bigbud/contracts/server/ipc.desktopCertificate.ts";

import { isElectron } from "~/config/env";
import { useBrowserPanelStore } from "../../stores/browser/browser.store";
import { closeBrowserTab, openNewBrowserTab } from "../../stores/browser/browserPanel.actions";
import { useBrowserAnnotation } from "./BrowserPanel.annotation.hook";
import {
  getUnsupportedBrowserOmniboxScheme,
  resolveBrowserOmniboxInput,
} from "./BrowserPanel.omnibox";
import {
  BrowserViewport,
  type BrowserPageMetadata,
  type BrowserViewportRef,
} from "./BrowserPanel.viewport";
import { isWebviewTagSupported } from "./BrowserPanel.viewport.webview.utils";
import { BrowserToolbar } from "./BrowserPanel.toolbar";
import { BrowserContextMenu, type ContextMenuItem } from "./BrowserPanel.contextMenu";
import { useBrowserContextMenu } from "./BrowserPanel.contextMenu.hook";
import { waitForVisibleBrowserNavigation } from "./BrowserPanel.agentNavigation";
import {
  executeBrowserTabActionWhenReady,
  registerBrowserTabAgentHandler,
} from "./browserAgentControl";
import {
  getBrowserBookmarks,
  getBrowserHistory,
  isBrowserBookmarked,
  recordBrowserHistoryVisit,
  subscribeBrowserData,
  toggleBrowserBookmark,
  updateBrowserHistoryVisitTitle,
} from "./BrowserPanel.history";
import { planDesktopBrowserContextMenu, planDesktopBrowserReload } from "./BrowserPanel.menuAction";
import { reloadBrowserViewport } from "./BrowserPanel.reload";
import { createBrowserContextMenuItems } from "./BrowserPanel.contextMenuItems";
import { BigbudLogo } from "../sidebar/SidebarProjectItem";
import { BrowserAgentCursor } from "./BrowserPanel.agentCursor";
import { BrowserAgentStatus } from "./BrowserPanel.agentStatus";
import type { BrowserLoadFailure } from "./BrowserPanel.navigationError";
import { BrowserPanelNavigationErrorPage } from "./BrowserPanel.navigationErrorPage";
import type { BrowserWebviewState } from "./BrowserPanel.viewport";
import { BrowserPanelWebviewStateErrorPage } from "./BrowserPanel.webviewStateErrorPage";
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
  const setTabFavicon = useBrowserPanelStore((state) => state.setTabFavicon);
  const setTabTitle = useBrowserPanelStore((state) => state.setTabTitle);
  const setTabUrl = useBrowserPanelStore((state) => state.setTabUrl);
  const [inputUrl, setInputUrl] = useState(url);
  const viewportRef = useRef<BrowserViewportRef>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loadError, setLoadError] = useState<BrowserLoadFailure | null>(null);
  const [loading, setLoading] = useState(false);
  const [webviewState, setWebviewState] = useState<BrowserWebviewState | null>(null);
  const [certificateChallenge, setCertificateChallenge] =
    useState<DesktopCertificateChallenge | null>(null);
  const [pageMetadata, setPageMetadata] = useState<BrowserPageMetadata>({
    title: "",
    faviconUrl: null,
  });
  const { annotationActive, cancelAnnotation, handleAnnotate } = useBrowserAnnotation({
    activeThreadId: activeThreadId ?? null,
    viewportRef,
  });
  const [browserHistory, setBrowserHistory] = useState(() => getBrowserHistory());
  const [bookmarks, setBookmarks] = useState(() => getBrowserBookmarks());
  const contextMenu = useBrowserContextMenu(visible && Boolean(url.trim()));
  const closeContextMenu = contextMenu.close;
  const toggleContextMenuCentered = contextMenu.toggleCentered;
  const [queuedDesktopReload, setQueuedDesktopReload] = useState<
    "normal" | "ignoring-cache" | null
  >(null);

  useEffect(
    () =>
      subscribeBrowserData(() => {
        setBrowserHistory(getBrowserHistory());
        setBookmarks(getBrowserBookmarks());
      }),
    [],
  );

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

  useEffect(() => {
    setTabFavicon(tabId, pageMetadata.faviconUrl);
  }, [pageMetadata.faviconUrl, setTabFavicon, tabId]);

  const reloadViewport = useCallback(
    (mode: "normal" | "ignoring-cache") => reloadBrowserViewport(viewportRef, mode),
    [],
  );

  const handleNavigate = useCallback(() => {
    const nextUrl = resolveBrowserOmniboxInput(inputUrl);
    if (!nextUrl) {
      if (getUnsupportedBrowserOmniboxScheme(inputUrl)) {
        setLoadError({
          errorCode: -1,
          errorDescription: "ERR_UNSUPPORTED_SCHEME",
          validatedURL: inputUrl,
        });
      }
      return;
    }
    setInputUrl(nextUrl);
    setLoadError(null);
    setTabUrl(tabId, nextUrl);
  }, [inputUrl, setTabUrl, tabId]);

  const handleSelectHistoryUrl = useCallback(
    (nextUrl: string) => {
      setInputUrl(nextUrl);
      setLoadError(null);
      setTabUrl(tabId, nextUrl);
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
    },
    [setTabUrl, tabId],
  );

  const handleNavigationCommit = useCallback((nextUrl: string) => {
    setBrowserHistory(recordBrowserHistoryVisit({ url: nextUrl, title: "" }));
  }, []);

  const handlePageMetadataChange = useCallback(
    (metadata: BrowserPageMetadata, metadataUrl?: string) => {
      setPageMetadata(metadata);
      if (metadata.title.trim() && metadataUrl) {
        setBrowserHistory(updateBrowserHistoryVisitTitle(metadataUrl, metadata.title));
      }
    },
    [],
  );

  const bookmarked = isBrowserBookmarked(bookmarks, url);
  const handleToggleBookmark = useCallback(() => {
    setBookmarks(toggleBrowserBookmark({ url, title: pageMetadata.title }));
  }, [pageMetadata.title, url]);

  const handleClose = useCallback(() => {
    if (annotationActive) {
      void cancelAnnotation().catch(() => undefined);
    }
    closeBrowserTab(tabId);
  }, [annotationActive, cancelAnnotation, tabId]);

  const handleOpenInExternalBrowser = useCallback(() => {
    const externalUrl = url.trim();
    if (!externalUrl) return;

    if (window.desktopBridge) {
      void window.desktopBridge.openExternal(externalUrl);
      return;
    }

    window.open(externalUrl, "_blank", "noopener,noreferrer");
  }, [url]);

  useEffect(() => {
    if ((!open || !visible) && annotationActive) {
      void cancelAnnotation().catch(() => undefined);
    }
  }, [annotationActive, cancelAnnotation, open, visible]);

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
        onStopLoading={() => viewportRef.current?.stopLoading?.()}
        onOpenInExternalBrowser={handleOpenInExternalBrowser}
        onAnnotate={handleAnnotate}
        annotationActive={annotationActive}
        pageMetadata={pageMetadata}
        historyUrls={browserHistory}
        annotationDisabled={!isElectron || !url.trim()}
        agentControlled={isAgentControlled}
        bookmarked={bookmarked}
        loading={loading}
        canStopLoading={isWebviewTagSupported()}
        onToggleBookmark={url.trim() ? handleToggleBookmark : undefined}
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
              onNavigationCommit={handleNavigationCommit}
              onNavigationStateChange={({ canGoBack: back, canGoForward: forward }) => {
                setCanGoBack(back);
                setCanGoForward(forward);
              }}
              onLoadStart={() => {
                setLoading(true);
                setLoadError(null);
                setWebviewState(null);
              }}
              onLoadStop={() => setLoading(false)}
              onLoadSuccess={() => {
                setLoading(false);
                setLoadError(null);
              }}
              onLoadFail={(failure) => {
                setLoading(false);
                setLoadError(failure);
              }}
              onWebviewStateChange={setWebviewState}
              onCertificateChallengeChange={setCertificateChallenge}
              onPageMetadataChange={handlePageMetadataChange}
              onContextMenu={isElectron ? contextMenu.openAtHostPoint : undefined}
            />
            <BrowserPanelNavigationErrorPage
              failure={loadError}
              certificateChallenge={certificateChallenge}
              agentControlled={isAgentControlled}
              onReload={() => viewportRef.current?.reload()}
              onGoBack={canGoBack ? () => viewportRef.current?.goBack() : undefined}
            />
            <BrowserPanelWebviewStateErrorPage
              state={webviewState}
              onReload={() => viewportRef.current?.reload()}
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
