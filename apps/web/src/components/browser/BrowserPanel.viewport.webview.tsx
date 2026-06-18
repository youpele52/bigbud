import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import {
  browserAnnotationCancelScript,
  browserAnnotationCleanupScript,
  browserAnnotationPickerScript,
  browserAnnotationPrepareCaptureScript,
  type BrowserAnnotationSelection,
} from "./BrowserPanel.annotation";
import { BrowserPdfAnnotationOverlay } from "./BrowserPanel.annotation.pdfOverlay";
import type {
  BrowserPageMetadata,
  BrowserViewportProps,
  BrowserViewportRef,
  ContextMenuEvent,
  ElectronWebview,
  FailLoadEvent,
  NavigateEvent,
  PageFaviconEvent,
  PageTitleEvent,
} from "./BrowserPanel.viewport.types";
import {
  browserSameTabPopupGuardScript,
  isWebviewReady,
  normalizeBrowserUrl,
  readAnnotationTheme,
} from "./BrowserPanel.viewport.webview.utils";
import {
  captureBrowserAnnotation,
  readIsPdfDocument,
  waitForNextPaint,
  waitForPdfAnnotationSelection,
  type PendingPdfAnnotation,
} from "./BrowserPanel.viewport.webview.annotation";

export const BrowserWebviewViewport = forwardRef<BrowserViewportRef, BrowserViewportProps>(
  function BrowserWebviewViewport(
    { url, onUrlChange, onNavigationStateChange, onLoadFail, onPageMetadataChange, onContextMenu },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const webviewRef = useRef<ElectronWebview | null>(null);
    const readyRef = useRef(false);
    const onUrlChangeRef = useRef(onUrlChange);
    const onNavigationStateChangeRef = useRef(onNavigationStateChange);
    const onLoadFailRef = useRef(onLoadFail);
    const onPageMetadataChangeRef = useRef(onPageMetadataChange);
    const onContextMenuRef = useRef(onContextMenu);
    const pageMetadataRef = useRef<BrowserPageMetadata>({ title: "", faviconUrl: null });
    const annotationActiveRef = useRef(false);
    const pendingPdfAnnotationRef = useRef<PendingPdfAnnotation | null>(null);
    const [pendingPdfAnnotation, setPendingPdfAnnotation] = useState<PendingPdfAnnotation | null>(
      null,
    );

    onUrlChangeRef.current = onUrlChange;
    onNavigationStateChangeRef.current = onNavigationStateChange;
    onLoadFailRef.current = onLoadFail;
    onPageMetadataChangeRef.current = onPageMetadataChange;
    onContextMenuRef.current = onContextMenu;

    useImperativeHandle(ref, () => ({
      goBack: () => runIfReady(webviewRef.current, readyRef.current, (webview) => webview.goBack()),
      goForward: () =>
        runIfReady(webviewRef.current, readyRef.current, (webview) => webview.goForward()),
      reload: () => runIfReady(webviewRef.current, readyRef.current, (webview) => webview.reload()),
      reloadIgnoringCache: () =>
        runIfReady(webviewRef.current, readyRef.current, (webview) =>
          webview.reloadIgnoringCache(),
        ),
      openDevTools: () =>
        runIfReady(webviewRef.current, readyRef.current, (webview) => webview.openDevTools()),
      cancelAnnotation: async () => {
        const webview = webviewRef.current;
        if (!webview || !annotationActiveRef.current) return;
        annotationActiveRef.current = false;
        const pendingPdfAnnotation = pendingPdfAnnotationRef.current;
        if (pendingPdfAnnotation) {
          pendingPdfAnnotationRef.current = null;
          setPendingPdfAnnotation(null);
          pendingPdfAnnotation.resolve({ cancelled: true });
          return;
        }
        await webview.executeJavaScript(`(${browserAnnotationCancelScript.toString()})()`, false);
      },
      startAnnotation: async () => {
        const webview = webviewRef.current;
        if (!webview || !readyRef.current) return null;
        const theme = readAnnotationTheme();
        const isPdfDocument = await readIsPdfDocument(webview, url);
        annotationActiveRef.current = true;
        try {
          const selection = isPdfDocument
            ? await waitForPdfAnnotationSelection(theme, pendingPdfAnnotationRef, (next) =>
                setPendingPdfAnnotation(next),
              )
            : await webview.executeJavaScript<BrowserAnnotationSelection>(
                `(${browserAnnotationPickerScript.toString()})(${JSON.stringify(theme)})`,
                true,
              );

          if (!selection || selection.cancelled) return null;

          if (isPdfDocument) {
            await waitForNextPaint();
          } else {
            await webview.executeJavaScript(
              `(${browserAnnotationPrepareCaptureScript.toString()})()`,
              false,
            );
          }

          return await captureBrowserAnnotation(webview, selection);
        } finally {
          annotationActiveRef.current = false;
          pendingPdfAnnotationRef.current = null;
          setPendingPdfAnnotation(null);
          if (!isPdfDocument) {
            void webview
              .executeJavaScript(`(${browserAnnotationCleanupScript.toString()})()`, false)
              .catch(() => {
                // Ignore transient cleanup failures after capture.
              });
          }
        }
      },
    }));

    useEffect(() => {
      if (!containerRef.current || webviewRef.current) return;

      let webview: ElectronWebview;
      try {
        webview = document.createElement("webview") as ElectronWebview;
        webview.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;";
        webview.setAttribute("allowpopups", "");
        webview.setAttribute("nodeintegration", "false");
        webview.setAttribute("plugins", "");
        webview.setAttribute("webpreferences", "contextIsolation=yes");
        webview.setAttribute(
          "useragent",
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
        );
      } catch {
        return;
      }

      webviewRef.current = webview;
      containerRef.current.appendChild(webview);

      const updateNavState = () => {
        const current = webviewRef.current;
        if (!current || !isWebviewReady(current)) return;
        readyRef.current = true;
        try {
          onNavigationStateChangeRef.current?.({
            canGoBack: current.canGoBack(),
            canGoForward: current.canGoForward(),
          });
        } catch {
          // Guest frame may not be ready yet; ignore transient state reads.
        }
      };

      const updatePageMetadata = (metadata: Partial<BrowserPageMetadata>) => {
        const next = {
          title: metadata.title ?? pageMetadataRef.current.title,
          faviconUrl:
            metadata.faviconUrl === undefined
              ? pageMetadataRef.current.faviconUrl
              : normalizeBrowserUrl(metadata.faviconUrl),
        };
        pageMetadataRef.current = next;
        try {
          onPageMetadataChangeRef.current?.(next);
        } catch {
          // Ignore transient callback errors during navigation.
        }
      };

      const readPageMetadata = () => {
        const current = webviewRef.current;
        if (!current || !isWebviewReady(current)) return;
        try {
          updatePageMetadata({ title: current.getTitle() || "" });
        } catch {
          // Guest frame may not be ready yet; ignore transient state reads.
        }
        void current
          .executeJavaScript<BrowserPageMetadata | null>(
            `(() => {
              const icon = document.querySelector('link[rel~="icon"], link[rel="shortcut icon"], link[rel~="apple-touch-icon"]');
              const href = icon instanceof HTMLLinkElement && icon.href ? icon.href : null;
              return { title: document.title || "", faviconUrl: href };
            })()`,
            false,
          )
          .then((metadata) => {
            if (!metadata) return;
            updatePageMetadata(metadata);
          })
          .catch(() => {
            // Cross-origin and transient navigation states can reject script execution.
          });
      };

      const installSameTabPopupGuard = () => {
        const current = webviewRef.current;
        if (!current || !isWebviewReady(current)) return;
        void current.executeJavaScript(browserSameTabPopupGuardScript, false).catch(() => {
          // Ignore transient script-injection failures during navigation.
        });
      };

      const handleNavigate = (event: NavigateEvent) => {
        updateNavState();
        if (event.url) {
          try {
            onUrlChangeRef.current?.(event.url);
            updatePageMetadata({ title: "", faviconUrl: null });
          } catch {
            // Ignore transient callback errors during navigation.
          }
        }
      };

      const handlePageTitle = (event: PageTitleEvent) => {
        updatePageMetadata({ title: event.title || "" });
      };

      const handlePageFavicon = (event: PageFaviconEvent) => {
        updatePageMetadata({ faviconUrl: event.favicons?.[0] ?? null });
      };

      const handleFailLoad = (event: FailLoadEvent) => {
        if (event.isMainFrame && event.errorCode !== -3) {
          try {
            onLoadFailRef.current?.({
              errorCode: event.errorCode,
              errorDescription: event.errorDescription,
              validatedURL: event.validatedURL,
            });
          } catch {
            // Ignore transient callback errors.
          }
        }
      };

      const handleContextMenu = (event: ContextMenuEvent) => {
        const params = event.params;
        if (!params) return;
        try {
          onContextMenuRef.current?.({
            x: params.x,
            y: params.y,
            linkURL: params.linkURL,
            selectionText: params.selectionText,
          });
        } catch {
          // Ignore transient callback errors during context menu.
        }
      };

      webview.addEventListener("did-navigate", handleNavigate as EventListener);
      webview.addEventListener("did-navigate-in-page", handleNavigate as EventListener);
      webview.addEventListener("dom-ready", updateNavState);
      webview.addEventListener("dom-ready", readPageMetadata);
      webview.addEventListener("dom-ready", installSameTabPopupGuard);
      webview.addEventListener("page-title-updated", handlePageTitle as EventListener);
      webview.addEventListener("page-favicon-updated", handlePageFavicon as EventListener);
      webview.addEventListener("did-fail-load", handleFailLoad as EventListener);
      webview.addEventListener("context-menu", handleContextMenu as EventListener);

      return () => {
        webview.removeEventListener("did-navigate", handleNavigate as EventListener);
        webview.removeEventListener("did-navigate-in-page", handleNavigate as EventListener);
        webview.removeEventListener("dom-ready", updateNavState);
        webview.removeEventListener("dom-ready", readPageMetadata);
        webview.removeEventListener("dom-ready", installSameTabPopupGuard);
        webview.removeEventListener("page-title-updated", handlePageTitle as EventListener);
        webview.removeEventListener("page-favicon-updated", handlePageFavicon as EventListener);
        webview.removeEventListener("did-fail-load", handleFailLoad as EventListener);
        webview.removeEventListener("context-menu", handleContextMenu as EventListener);
        annotationActiveRef.current = false;
        pendingPdfAnnotationRef.current?.resolve({ cancelled: true });
        pendingPdfAnnotationRef.current = null;
        setPendingPdfAnnotation(null);
        readyRef.current = false;
        try {
          webview.remove();
        } catch {
          // Ignore errors during cleanup.
        }
        webviewRef.current = null;
      };
    }, []);

    useEffect(() => {
      const webview = webviewRef.current;
      if (!webview) return;
      const currentSrc = webview.getAttribute("src");
      if (currentSrc !== url) {
        try {
          webview.setAttribute("src", url);
        } catch {
          // Guest frame may be navigating or detached; ignore transient errors.
        }
      }
    }, [url]);

    return (
      <div ref={containerRef} className="absolute inset-0">
        {pendingPdfAnnotation && (
          <BrowserPdfAnnotationOverlay
            theme={pendingPdfAnnotation.theme}
            onResolve={(selection) => {
              const pending = pendingPdfAnnotationRef.current;
              pendingPdfAnnotationRef.current = null;
              setPendingPdfAnnotation(null);
              pending?.resolve(selection);
            }}
          />
        )}
      </div>
    );
  },
);

function runIfReady(
  webview: ElectronWebview | null,
  ready: boolean,
  action: (webview: ElectronWebview) => void,
) {
  if (!webview || !ready) return;
  try {
    action(webview);
  } catch {
    // Ignore transient webview errors.
  }
}
