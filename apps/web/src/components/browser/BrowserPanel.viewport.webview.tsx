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
  BrowserViewportProps,
  BrowserViewportRef,
  ElectronWebview,
} from "./BrowserPanel.viewport.types";
import { readAnnotationTheme, runIfReady } from "./BrowserPanel.viewport.webview.utils";
import {
  captureBrowserAnnotation,
  readIsPdfDocument,
  waitForNextPaint,
  waitForPdfAnnotationSelection,
  type PendingPdfAnnotation,
} from "./BrowserPanel.viewport.webview.annotation";
import { executeWebviewAgentAction } from "./BrowserPanel.viewport.webview.agent";
import { navigateElectronWebview } from "./BrowserPanel.viewport.webview.navigate";
import { bindWebviewLifecycle } from "./BrowserPanel.viewport.webview.lifecycle";
import { assignBrowserWebviewPartition } from "./BrowserPanel.viewport.webview.partition";

export const BrowserWebviewViewport = forwardRef<BrowserViewportRef, BrowserViewportProps>(
  function BrowserWebviewViewport(
    {
      url,
      onUrlChange,
      onNavigationCommit,
      onNavigationStateChange,
      onLoadStart,
      onLoadStop,
      onLoadSuccess,
      onLoadFail,
      onWebviewStateChange,
      onCertificateChallengeChange,
      onPageMetadataChange,
      onContextMenu,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const webviewRef = useRef<ElectronWebview | null>(null);
    const readyRef = useRef(false);
    const onUrlChangeRef = useRef(onUrlChange);
    const onNavigationCommitRef = useRef(onNavigationCommit);
    const onNavigationStateChangeRef = useRef(onNavigationStateChange);
    const onLoadFailRef = useRef(onLoadFail);
    const onCertificateChallengeChangeRef = useRef(onCertificateChallengeChange);
    const onLoadStartRef = useRef(onLoadStart);
    const onLoadStopRef = useRef(onLoadStop);
    const onLoadSuccessRef = useRef(onLoadSuccess);
    const onWebviewStateChangeRef = useRef(onWebviewStateChange);
    const onPageMetadataChangeRef = useRef(onPageMetadataChange);
    const onContextMenuRef = useRef(onContextMenu);
    const annotationActiveRef = useRef(false);
    const pendingPdfAnnotationRef = useRef<PendingPdfAnnotation | null>(null);
    const [pendingPdfAnnotation, setPendingPdfAnnotation] = useState<PendingPdfAnnotation | null>(
      null,
    );
    const urlRef = useRef(url);
    urlRef.current = url;

    onUrlChangeRef.current = onUrlChange;
    onNavigationCommitRef.current = onNavigationCommit;
    onNavigationStateChangeRef.current = onNavigationStateChange;
    onLoadFailRef.current = onLoadFail;
    onCertificateChallengeChangeRef.current = onCertificateChallengeChange;
    onLoadStartRef.current = onLoadStart;
    onLoadStopRef.current = onLoadStop;
    onLoadSuccessRef.current = onLoadSuccess;
    onWebviewStateChangeRef.current = onWebviewStateChange;
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
      stopLoading: () =>
        runIfReady(webviewRef.current, readyRef.current, (webview) => webview.stop?.()),
      openDevTools: () =>
        runIfReady(webviewRef.current, readyRef.current, (webview) => webview.openDevTools()),
      inspectElement: (x, y) =>
        runIfReady(webviewRef.current, readyRef.current, (webview) => webview.inspectElement(x, y)),
      undo: () => runIfReady(webviewRef.current, readyRef.current, (webview) => webview.undo()),
      redo: () => runIfReady(webviewRef.current, readyRef.current, (webview) => webview.redo()),
      cut: () => runIfReady(webviewRef.current, readyRef.current, (webview) => webview.cut()),
      copy: () => runIfReady(webviewRef.current, readyRef.current, (webview) => webview.copy()),
      paste: () => runIfReady(webviewRef.current, readyRef.current, (webview) => webview.paste()),
      selectAll: () =>
        runIfReady(webviewRef.current, readyRef.current, (webview) => webview.selectAll()),
      executeAgentAction: async (action) => {
        const webview = webviewRef.current;
        if (!webview || !readyRef.current) {
          throw new Error("The visible browser tab is not ready.");
        }
        return executeWebviewAgentAction(webview, action);
      },
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
        assignBrowserWebviewPartition(webview);
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
      const cleanupLifecycle = bindWebviewLifecycle({
        bridge: window.desktopBridge,
        getUrl: () => urlRef.current,
        onCertificateChallengeChange: (challenge) =>
          onCertificateChallengeChangeRef.current?.(challenge),
        onContextMenu: (event) => onContextMenuRef.current?.(event),
        onLoadFail: (failure) => onLoadFailRef.current?.(failure),
        onLoadStart: () => onLoadStartRef.current?.(),
        onLoadStop: () => onLoadStopRef.current?.(),
        onLoadSuccess: () => onLoadSuccessRef.current?.(),
        onWebviewStateChange: (state) => onWebviewStateChangeRef.current?.(state),
        onNavigationStateChange: (state) => {
          readyRef.current = true;
          onNavigationStateChangeRef.current?.(state);
        },
        onPageMetadataChange: (metadata, metadataUrl) =>
          onPageMetadataChangeRef.current?.(metadata, metadataUrl),
        onNavigationCommit: (nextUrl) => onNavigationCommitRef.current?.(nextUrl),
        onUrlChange: (nextUrl) => onUrlChangeRef.current?.(nextUrl),
        webview,
      });
      navigateElectronWebview(webview, urlRef.current);

      return () => {
        cleanupLifecycle();
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
      navigateElectronWebview(webview, url);
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
