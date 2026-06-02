import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ThreadId } from "@bigbud/contracts";
import { randomUUID } from "~/lib/utils";
import { isElectron } from "~/config/env";
import { useComposerDraftStore } from "~/stores/composer";
import { toastManager } from "../ui/toast";
import { useBrowserPanelStore } from "../../stores/browser/browser.store";
import { closeBrowserPanel, openBrowserPanel } from "../../stores/browser/browserPanel.actions";
import { closeFilesPanel, openFilesPanel } from "../../stores/files/filesPanel.coordinator";
import { useProjectById, useThreadById } from "../../stores/main";
import { useRightPanelTabsStore } from "../../stores/rightPanel/rightPanelTabs.store";
import {
  closeTerminalPanel,
  openTerminalPanel,
} from "../../stores/terminal/terminalPanel.coordinator";
import { useUiStateStore } from "../../stores/ui";
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
import { RightPanelShell } from "../right-panel/RightPanelShell";
import { RightPanelTabs } from "../right-panel/RightPanelTabs";
import { useRightPanelWidth } from "../right-panel/useRightPanelWidth";
import { useDefaultChatCwd } from "../../rpc/serverState";

const BROWSER_PANEL_WIDTH_STORAGE_KEY = "browser_panel_width";
const BROWSER_PANEL_MIN_WIDTH = 320;

interface BrowserPanelProps {
  className?: string;
  activeThreadId?: ThreadId | null;
}

export const BrowserPanel = memo(function BrowserPanel({
  className,
  activeThreadId,
}: BrowserPanelProps) {
  const { open, url, setUrl } = useBrowserPanelStore();
  const activeTab = useRightPanelTabsStore((state) => state.activeKind);
  const setActiveTab = useRightPanelTabsStore((state) => state.setActiveTab);
  const thread = useThreadById(activeThreadId ?? null);
  const selectedProjectId = useUiStateStore((state) => state.selectedProjectId);
  const project = useProjectById(thread?.projectId ?? selectedProjectId ?? null);
  const defaultChatCwd = useDefaultChatCwd();
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
  const [contextMenu, setContextMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
  }>({ open: false, x: 0, y: 0 });
  const [queuedDesktopReload, setQueuedDesktopReload] = useState<
    "normal" | "ignoring-cache" | null
  >(null);
  const { panelWidth, onResizePointerDown } = useRightPanelWidth({
    minWidth: BROWSER_PANEL_MIN_WIDTH,
    storageKey: BROWSER_PANEL_WIDTH_STORAGE_KEY,
  });
  const workspaceRoot = thread?.worktreePath ?? project?.cwd ?? defaultChatCwd ?? null;
  const visible = open && activeTab === "browser";

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
    setUrl(nextUrl);
    setBrowserHistory(recordBrowserHistoryUrl(nextUrl));
  }, [inputUrl, setUrl]);

  const handleSelectHistoryUrl = useCallback(
    (nextUrl: string) => {
      setInputUrl(nextUrl);
      setUrl(nextUrl);
      setBrowserHistory(recordBrowserHistoryUrl(nextUrl));
    },
    [setUrl],
  );

  const handleCancelEmptyUrlEdit = useCallback(() => {
    setInputUrl(url);
  }, [url]);

  const handleUrlChange = useCallback(
    (nextUrl: string) => {
      setInputUrl(nextUrl);
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
    closeBrowserPanel();
  }, [annotationActive]);

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
        comment: annotation.comment,
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
        setActiveTab("browser");
        return;
      }

      reloadViewport(reloadPlan.reloadMode);
    });

    return () => {
      unsubscribe?.();
    };
  }, [open, reloadViewport, setActiveTab, visible]);

  useEffect(() => {
    if (!visible || !queuedDesktopReload) {
      return;
    }

    reloadViewport(queuedDesktopReload);
    setQueuedDesktopReload(null);
  }, [queuedDesktopReload, reloadViewport, visible]);

  if (!visible) return null;

  const contextMenuItems: ContextMenuItem[] = createBrowserContextMenuItems(
    {
      canGoBack,
      canGoForward,
    },
    viewportRef,
  );

  return (
    <RightPanelShell
      open={open}
      width={panelWidth}
      className={className}
      onResizePointerDown={onResizePointerDown}
      resizeAriaLabel="Resize browser panel"
    >
      <RightPanelTabs
        browserShortcutLabel={null}
        filesShortcutLabel={null}
        hasActiveProject={Boolean(workspaceRoot)}
        onCloseBrowser={closeBrowserPanel}
        onCloseFiles={closeFilesPanel}
        onCloseTerminal={closeTerminalPanel}
        onOpenBrowser={() => openBrowserPanel({ url })}
        onOpenFiles={openFilesPanel}
        onOpenTerminal={openTerminalPanel}
        terminalAvailable={Boolean(workspaceRoot)}
        terminalShortcutLabel={null}
      />
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
    </RightPanelShell>
  );
});

export default BrowserPanel;
