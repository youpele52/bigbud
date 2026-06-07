import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ThreadId } from "@bigbud/contracts";

import { randomUUID } from "~/lib/utils";
import { isElectron } from "~/config/env";
import { useComposerDraftStore } from "~/stores/composer";
import { normalizeAnnotationComment } from "~/stores/composer/types.annotation.store";
import type { RightPanelTabId } from "~/stores/rightPanel/rightPanelTabs.store";
import { toastManager } from "../ui/toast";
import { useBrowserPanelStore } from "../../stores/browser/browser.store";
import { closeBrowserTab } from "../../stores/browser/browserPanel.actions";
import { dataUrlToFile } from "./BrowserPanel.annotation";
import {
  BrowserViewport,
  type BrowserPageMetadata,
  type BrowserViewportProps,
  type BrowserViewportRef,
} from "./BrowserPanel.viewport";
import { BrowserToolbar } from "./BrowserPanel.toolbar";
import { BrowserContextMenu, type ContextMenuItem } from "./BrowserPanel.contextMenu";
import { getBrowserHistory, recordBrowserHistoryUrl } from "./BrowserPanel.history";
import { planDesktopBrowserReload } from "./BrowserPanel.menuAction";
import { createBrowserContextMenuItems } from "./BrowserPanel.contextMenuItems";
import { BigbudLogo } from "../sidebar/SidebarProjectItem";

interface BrowserPanelProps {
  activeThreadId?: ThreadId | null;
  tabId?: RightPanelTabId;
  visible?: boolean;
}

export const BrowserPanelContent = memo(function BrowserPanelContent({
  activeThreadId,
  tabId = "browser",
  visible = true,
}: BrowserPanelProps) {
  const open = useBrowserPanelStore((state) => state.open);
  const url = useBrowserPanelStore((state) => state.tabsById[tabId]?.url ?? "");
  const ensureTab = useBrowserPanelStore((state) => state.ensureTab);
  const setTabTitle = useBrowserPanelStore((state) => state.setTabTitle);
  const setTabUrl = useBrowserPanelStore((state) => state.setTabUrl);
  const addComposerImage = useComposerDraftStore((state) => state.addImage);
  const addComposerAnnotation = useComposerDraftStore((state) => state.addAnnotation);
  const [inputUrl, setInputUrl] = useState(url);
  const viewportRef = useRef<BrowserViewportRef>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageMetadata, setPageMetadata] = useState<BrowserPageMetadata>({
    title: "",
    faviconUrl: null,
  });
  const [annotationActive, setAnnotationActive] = useState(false);
  const [browserHistory, setBrowserHistory] = useState(() => getBrowserHistory());
  const [contextMenu, setContextMenu] = useState<{ open: boolean; x: number; y: number }>({
    open: false,
    x: 0,
    y: 0,
  });
  const [queuedDesktopReload, setQueuedDesktopReload] = useState<
    "normal" | "ignoring-cache" | null
  >(null);

  useEffect(() => {
    ensureTab(tabId, url);
  }, [ensureTab, tabId, url]);

  useEffect(() => {
    setTabTitle(tabId, pageMetadata.title.trim());
  }, [pageMetadata.title, setTabTitle, tabId]);

  const reloadViewport = useCallback((mode: "normal" | "ignoring-cache") => {
    if (mode === "ignoring-cache") {
      viewportRef.current?.reloadIgnoringCache();
      return;
    }

    viewportRef.current?.reload();
  }, []);

  const handleNavigate = useCallback(() => {
    let nextUrl = inputUrl.trim();
    if (!nextUrl) return;
    if (!/^https?:\/\//i.test(nextUrl)) {
      nextUrl = `https://${nextUrl}`;
    }
    setInputUrl(nextUrl);
    setTabUrl(tabId, nextUrl);
    setBrowserHistory(recordBrowserHistoryUrl(nextUrl));
  }, [inputUrl, setTabUrl, tabId]);

  const handleSelectHistoryUrl = useCallback(
    (nextUrl: string) => {
      setInputUrl(nextUrl);
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

  const handleLoadFail = useCallback(
    (info: { errorCode: number; errorDescription: string; validatedURL: string }) => {
      setLoadError(info.errorDescription);
    },
    [],
  );

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

      const file = dataUrlToFile(
        annotation.screenshot.dataUrl,
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
  }, [open, reloadViewport, visible]);

  useEffect(() => {
    if (!queuedDesktopReload) {
      return;
    }

    reloadViewport(queuedDesktopReload);
    setQueuedDesktopReload(null);
  }, [queuedDesktopReload, reloadViewport]);

  const contextMenuItems: ContextMenuItem[] = createBrowserContextMenuItems(
    {
      canGoBack,
      canGoForward,
    },
    viewportRef,
  );

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
      />
      {loadError && (
        <div className="shrink-0 border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {loadError}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
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
              onNavigationStateChange={({
                canGoBack: back,
                canGoForward: forward,
              }: Parameters<NonNullable<BrowserViewportProps["onNavigationStateChange"]>>[0]) => {
                setCanGoBack(back);
                setCanGoForward(forward);
                if (back || forward) {
                  setLoadError(null);
                }
              }}
              onLoadFail={handleLoadFail}
              onPageMetadataChange={setPageMetadata}
              onContextMenu={
                isElectron
                  ? ({
                      x,
                      y,
                    }: Parameters<NonNullable<BrowserViewportProps["onContextMenu"]>>[0]) => {
                      setContextMenu({ open: true, x, y });
                    }
                  : undefined
              }
            />
            <BrowserContextMenu
              open={contextMenu.open}
              x={contextMenu.x}
              y={contextMenu.y}
              items={contextMenuItems}
              onClose={() => setContextMenu((prev) => ({ ...prev, open: false }))}
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
