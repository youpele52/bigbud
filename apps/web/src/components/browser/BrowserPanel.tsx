import { memo, useCallback, useEffect, useRef, useState } from "react";
import * as Schema from "effect/Schema";
import { cn } from "~/lib/utils";
import { isElectron } from "~/config/env";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { useBrowserPanelStore } from "../../stores/browser/browser.store";
import { BrowserViewport, type BrowserViewportRef } from "./BrowserPanel.viewport";
import { BrowserToolbar } from "./BrowserPanel.toolbar";
import { BrowserContextMenu, type ContextMenuItem } from "./BrowserPanel.contextMenu";

const BROWSER_PANEL_WIDTH_STORAGE_KEY = "browser_panel_width";
const BROWSER_PANEL_MIN_WIDTH = 320;
const getBrowserPanelMaxWidth = () => Math.floor(window.innerWidth * 0.8);
const getBrowserPanelDefaultWidth = () =>
  Math.max(BROWSER_PANEL_MIN_WIDTH, Math.floor(window.innerWidth / 3));

interface BrowserPanelProps {
  className?: string;
}

export const BrowserPanel = memo(function BrowserPanel({ className }: BrowserPanelProps) {
  const { open, url, setOpen, setUrl } = useBrowserPanelStore();
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
  }, [inputUrl, setUrl]);

  const handleUrlChange = useCallback(
    (nextUrl: string) => {
      setInputUrl(nextUrl);
      setActiveUrl(nextUrl);
      setUrl(nextUrl);
    },
    [setUrl],
  );

  const handleClose = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  const handleLoadFail = useCallback(
    (info: { errorCode: number; errorDescription: string; validatedURL: string }) => {
      setLoadError(info.errorDescription);
    },
    [],
  );

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
        setPanelWidth(Math.max(BROWSER_PANEL_MIN_WIDTH, max));
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [panelWidth]);

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
      <div className="hidden shrink-0 bg-transparent md:block" style={{ width: panelWidth }} />
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
          onClose={handleClose}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onGoBack={() => viewportRef.current?.goBack()}
          onGoForward={() => viewportRef.current?.goForward()}
          onReload={() => viewportRef.current?.reload()}
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
