import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ThreadId } from "@bigbud/contracts";
import * as Schema from "effect/Schema";
import { cn, randomUUID } from "~/lib/utils";
import { isElectron } from "~/config/env";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { useComposerDraftStore } from "~/stores/composer";
import {
  getLeftSidebarGapWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH_PX,
} from "../layout/chatLayout.shared";
import { toastManager } from "../ui/toast";
import { useBrowserPanelStore } from "../../stores/browser/browser.store";
import { dataUrlToFile } from "./BrowserPanel.annotation";
import {
  BrowserViewport,
  type BrowserPageMetadata,
  type BrowserViewportRef,
} from "./BrowserPanel.viewport";
import { BrowserToolbar } from "./BrowserPanel.toolbar";
import { BrowserContextMenu, type ContextMenuItem } from "./BrowserPanel.contextMenu";
import { getBrowserHistory, recordBrowserHistoryUrl } from "./BrowserPanel.history";

const BROWSER_PANEL_WIDTH_STORAGE_KEY = "browser_panel_width";
const BROWSER_PANEL_MIN_WIDTH = 320;
const getBrowserPanelMaxWidth = () => {
  const viewportMaxWidth = Math.floor(window.innerWidth * 0.8);
  const sharedLayoutMaxWidth = Math.floor(
    window.innerWidth - getLeftSidebarGapWidth() - THREAD_MAIN_CONTENT_MIN_WIDTH_PX,
  );

  return Math.max(BROWSER_PANEL_MIN_WIDTH, Math.min(viewportMaxWidth, sharedLayoutMaxWidth));
};
const getBrowserPanelDefaultWidth = () =>
  Math.max(BROWSER_PANEL_MIN_WIDTH, Math.floor(window.innerWidth / 3));

interface BrowserPanelProps {
  className?: string;
  activeThreadId?: ThreadId | null;
}

export const BrowserPanel = memo(function BrowserPanel({
  className,
  activeThreadId,
}: BrowserPanelProps) {
  const { open, url, setOpen, setUrl } = useBrowserPanelStore();
  const addComposerImage = useComposerDraftStore((state) => state.addImage);
  const addComposerAnnotation = useComposerDraftStore((state) => state.addAnnotation);
  const [inputUrl, setInputUrl] = useState(url || "https://example.com");
  const [activeUrl, setActiveUrl] = useState(url || "https://example.com");
  const [panelWidth, setPanelWidth] = useState(() => {
    const stored = getLocalStorageItem(BROWSER_PANEL_WIDTH_STORAGE_KEY, Schema.Finite);
    const max = getBrowserPanelMaxWidth();
    return stored
      ? Math.max(BROWSER_PANEL_MIN_WIDTH, Math.min(max, stored))
      : getBrowserPanelDefaultWidth();
  });
  const [resizing, setResizing] = useState(false);
  const startRef = useRef<{ x: number; width: number } | null>(null);
  const pendingWidthRef = useRef(panelWidth);
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
  const [contextMenu, setContextMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
  }>({ open: false, x: 0, y: 0 });

  const handleNavigate = useCallback(() => {
    let nextUrl = inputUrl.trim();
    if (!nextUrl) return;
    if (!/^https?:\/\//i.test(nextUrl)) {
      nextUrl = `https://${nextUrl}`;
    }
    setInputUrl(nextUrl);
    setActiveUrl(nextUrl);
    setUrl(nextUrl);
    setBrowserHistory(recordBrowserHistoryUrl(nextUrl));
  }, [inputUrl, setUrl]);

  const handleSelectHistoryUrl = useCallback(
    (nextUrl: string) => {
      setInputUrl(nextUrl);
      setActiveUrl(nextUrl);
      setUrl(nextUrl);
      setBrowserHistory(recordBrowserHistoryUrl(nextUrl));
    },
    [setUrl],
  );

  const handleCancelEmptyUrlEdit = useCallback(() => {
    setInputUrl(activeUrl);
  }, [activeUrl]);

  const handleUrlChange = useCallback(
    (nextUrl: string) => {
      setInputUrl(nextUrl);
      setActiveUrl(nextUrl);
      setUrl(nextUrl);
      setBrowserHistory(recordBrowserHistoryUrl(nextUrl));
    },
    [setUrl],
  );

  const handleClose = useCallback(() => {
    if (annotationActive) {
      void viewportRef.current?.cancelAnnotation();
      setAnnotationActive(false);
    }
    setOpen(false);
  }, [annotationActive, setOpen]);

  const handleOpenInExternalBrowser = useCallback(() => {
    const externalUrl = activeUrl.trim();
    if (!externalUrl) return;

    if (window.desktopBridge) {
      void window.desktopBridge.openExternal(externalUrl);
      return;
    }

    window.open(externalUrl, "_blank", "noopener,noreferrer");
  }, [activeUrl]);

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
        comment: annotation.comment,
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

  const onPanelResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setResizing(true);
      startRef.current = { x: e.clientX, width: panelWidth };
    },
    [panelWidth],
  );

  useEffect(() => {
    const handleResize = () => {
      const max = getBrowserPanelMaxWidth();
      if (panelWidth > max) {
        const nextWidth = Math.max(BROWSER_PANEL_MIN_WIDTH, max);
        pendingWidthRef.current = nextWidth;
        setPanelWidth(nextWidth);
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [panelWidth]);

  useEffect(() => {
    if (!open || typeof ResizeObserver === "undefined") {
      return;
    }

    const leftSidebarGap = document.querySelector<HTMLElement>(
      "[data-slot='sidebar'][data-side='left'] [data-slot='sidebar-gap']",
    );
    if (!leftSidebarGap) {
      return;
    }

    const observer = new ResizeObserver(() => {
      const max = getBrowserPanelMaxWidth();
      setPanelWidth((currentWidth) => {
        const nextWidth = Math.min(currentWidth, max);
        pendingWidthRef.current = nextWidth;
        return nextWidth;
      });
    });
    observer.observe(leftSidebarGap);

    return () => {
      observer.disconnect();
    };
  }, [open]);

  useEffect(() => {
    const nextUrl = url.trim();
    if (!nextUrl) return;
    setInputUrl(nextUrl);
    setActiveUrl((currentUrl) => (currentUrl === nextUrl ? currentUrl : nextUrl));
  }, [url]);

  useEffect(() => {
    if (!resizing) return;
    const onPointerMove = (e: PointerEvent) => {
      const start = startRef.current;
      if (!start) return;
      const delta = start.x - e.clientX;
      const nextWidth = Math.max(
        BROWSER_PANEL_MIN_WIDTH,
        Math.min(getBrowserPanelMaxWidth(), start.width + delta),
      );
      setPanelWidth(nextWidth);
      pendingWidthRef.current = nextWidth;
    };
    const onPointerUp = () => {
      setResizing(false);
      startRef.current = null;
      setLocalStorageItem(BROWSER_PANEL_WIDTH_STORAGE_KEY, pendingWidthRef.current, Schema.Finite);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [resizing]);

  if (!open) return null;

  const contextMenuItems: ContextMenuItem[] = [
    {
      id: "back",
      label: "Back",
      disabled: !canGoBack,
      onClick: () => viewportRef.current?.goBack(),
    },
    {
      id: "forward",
      label: "Forward",
      disabled: !canGoForward,
      onClick: () => viewportRef.current?.goForward(),
    },
    {
      id: "reload",
      label: "Reload",
      onClick: () => viewportRef.current?.reload(),
    },
    { id: "sep1", label: "", separator: true, onClick: () => undefined },
    {
      id: "inspect",
      label: "Inspect",
      onClick: () => viewportRef.current?.openDevTools(),
    },
  ];

  return (
    <>
      <div
        className="hidden shrink-0 bg-transparent md:block"
        data-browser-panel-placeholder="true"
        style={{ width: panelWidth }}
      />
      <div
        className={cn(
          "fixed right-0 top-0 z-40 flex h-dvh flex-col border-l border-border bg-card text-foreground",
          className,
        )}
        style={{ width: panelWidth }}
      >
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
          annotationDisabled={!isElectron}
        />
        {loadError && (
          <div className="shrink-0 border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {loadError}
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          <BrowserViewport
            ref={viewportRef}
            url={activeUrl}
            onUrlChange={handleUrlChange}
            onNavigationStateChange={({ canGoBack: back, canGoForward: forward }) => {
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
                ? ({ x, y }) => {
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
        </div>
        <div
          className="absolute inset-y-0 left-0 z-50 hidden w-4 cursor-col-resize md:block"
          onPointerDown={onPanelResizePointerDown}
          role="button"
          aria-label="Resize browser panel"
          tabIndex={0}
        >
          <div className="absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 bg-transparent transition-colors hover:bg-border" />
        </div>
      </div>
    </>
  );
});

export default BrowserPanel;
