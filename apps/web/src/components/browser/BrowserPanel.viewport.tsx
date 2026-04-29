import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from "react";
import { isElectron } from "~/config/env";

export interface BrowserViewportRef {
  goBack(): void;
  goForward(): void;
  reload(): void;
  openDevTools(): void;
}

export interface BrowserViewportProps {
  url: string;
  onUrlChange?: ((url: string) => void) | undefined;
  onNavigationStateChange?:
    | ((state: { canGoBack: boolean; canGoForward: boolean }) => void)
    | undefined;
  onLoadFail?:
    | ((info: { errorCode: number; errorDescription: string; validatedURL: string }) => void)
    | undefined;
  onContextMenu?:
    | ((event: {
        x: number;
        y: number;
        linkURL?: string | undefined;
        selectionText?: string | undefined;
      }) => void)
    | undefined;
}

type ElectronWebview = HTMLElement & {
  goBack(): void;
  goForward(): void;
  reload(): void;
  reloadIgnoringCache(): void;
  openDevTools(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  getTitle(): string;
  getWebContentsId(): number;
};

type NavigateEvent = Event & { url: string };
type ContextMenuEvent = Event & {
  params: {
    x: number;
    y: number;
    linkURL?: string;
    selectionText?: string;
  };
};
type FailLoadEvent = Event & {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
};

/** Detect whether the Electron `<webview>` tag is actually usable in the current
 *  renderer.  `webviewTag: true` must be present in the BrowserWindow
 *  webPreferences; without it the element exists but its guest frame is broken
 *  and every API access throws. */
function isWebviewTagSupported(): boolean {
  if (!isElectron) return false;
  try {
    const wv = document.createElement("webview");
    return typeof (wv as ElectronWebview).getWebContentsId === "function";
  } catch {
    return false;
  }
}

function isWebviewReady(webview: ElectronWebview): boolean {
  try {
    const id = webview.getWebContentsId();
    return typeof id === "number" && Number.isFinite(id);
  } catch {
    return false;
  }
}

const WebViewViewport = forwardRef<BrowserViewportRef, BrowserViewportProps>(
  function WebViewViewport(
    { url, onUrlChange, onNavigationStateChange, onLoadFail, onContextMenu },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const webviewRef = useRef<ElectronWebview | null>(null);
    const readyRef = useRef(false);
    const onUrlChangeRef = useRef(onUrlChange);
    const onNavigationStateChangeRef = useRef(onNavigationStateChange);
    const onLoadFailRef = useRef(onLoadFail);
    const onContextMenuRef = useRef(onContextMenu);
    const urlRef = useRef(url);

    onUrlChangeRef.current = onUrlChange;
    onNavigationStateChangeRef.current = onNavigationStateChange;
    onLoadFailRef.current = onLoadFail;
    onContextMenuRef.current = onContextMenu;
    urlRef.current = url;

    useImperativeHandle(ref, () => ({
      goBack: () => {
        const w = webviewRef.current;
        if (!w || !readyRef.current) return;
        try {
          w.goBack();
        } catch {
          /* ignore transient errors */
        }
      },
      goForward: () => {
        const w = webviewRef.current;
        if (!w || !readyRef.current) return;
        try {
          w.goForward();
        } catch {
          /* ignore transient errors */
        }
      },
      reload: () => {
        const w = webviewRef.current;
        if (!w || !readyRef.current) return;
        try {
          w.reload();
        } catch {
          /* ignore transient errors */
        }
      },
      openDevTools: () => {
        const w = webviewRef.current;
        if (!w || !readyRef.current) return;
        try {
          w.openDevTools();
        } catch {
          /* ignore transient errors */
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
        const w = webviewRef.current;
        if (!w) return;
        if (!isWebviewReady(w)) return;
        readyRef.current = true;
        try {
          onNavigationStateChangeRef.current?.({
            canGoBack: w.canGoBack(),
            canGoForward: w.canGoForward(),
          });
        } catch {
          // Guest frame may not be ready yet; ignore transient state reads.
        }
      };

      const handleNavigate = (e: NavigateEvent) => {
        updateNavState();
        if (e.url) {
          try {
            onUrlChangeRef.current?.(e.url);
          } catch {
            // Ignore transient callback errors during navigation.
          }
        }
      };

      const handleFailLoad = (e: FailLoadEvent) => {
        // ERR_ABORTED (-3) is a normal navigation cancellation (e.g. redirect,
        // stop, or quick back/forward). It should not be surfaced as an error.
        if (e.isMainFrame && e.errorCode !== -3) {
          try {
            onLoadFailRef.current?.({
              errorCode: e.errorCode,
              errorDescription: e.errorDescription,
              validatedURL: e.validatedURL,
            });
          } catch {
            // Ignore transient callback errors.
          }
        }
      };

      const handleContextMenu = (e: ContextMenuEvent) => {
        const params = e.params;
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
      webview.addEventListener("did-fail-load", handleFailLoad as EventListener);
      webview.addEventListener("context-menu", handleContextMenu as EventListener);

      return () => {
        webview.removeEventListener("did-navigate", handleNavigate as EventListener);
        webview.removeEventListener("did-navigate-in-page", handleNavigate as EventListener);
        webview.removeEventListener("dom-ready", updateNavState);
        webview.removeEventListener("did-fail-load", handleFailLoad as EventListener);
        webview.removeEventListener("context-menu", handleContextMenu as EventListener);
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

    return <div ref={containerRef} className="absolute inset-0" />;
  },
);

const IFrameViewport = forwardRef<BrowserViewportRef, BrowserViewportProps>(function IFrameViewport(
  { url, onUrlChange, onLoadFail },
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const onUrlChangeRef = useRef(onUrlChange);
  const onLoadFailRef = useRef(onLoadFail);
  const [errorUrl, setErrorUrl] = useState<string | null>(null);

  onUrlChangeRef.current = onUrlChange;
  onLoadFailRef.current = onLoadFail;

  useImperativeHandle(ref, () => ({
    goBack: () => undefined,
    goForward: () => undefined,
    reload: () => {
      const iframe = iframeRef.current;
      if (!iframe) return;
      try {
        iframe.contentWindow?.location.reload();
      } catch {
        iframe.src = url;
      }
    },
    openDevTools: () => undefined,
  }));

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const currentSrc = iframe.getAttribute("src");
    if (currentSrc !== url) {
      iframe.setAttribute("src", url);
      setErrorUrl(null);
    }
  }, [url]);

  const handleLoad = () => {
    // Cross-origin restrictions prevent us from inspecting iframe contents,
    // but we can at least report that the initial URL was loaded.
    // X-Frame-Options failures load the browser's error page silently,
    // so we rely on the user noticing and using the external-open option.
    try {
      onUrlChangeRef.current?.(url);
    } catch {
      // Ignore transient callback errors.
    }
  };

  const handleError = () => {
    setErrorUrl(url);
    try {
      onLoadFailRef.current?.({
        errorCode: -3,
        errorDescription: "Failed to load in embedded browser. The site may block framing.",
        validatedURL: url,
      });
    } catch {
      // Ignore transient callback errors.
    }
  };

  return (
    <>
      <iframe
        ref={iframeRef}
        src={url}
        className="absolute inset-0 h-full w-full border-0"
        title="Browser"
        sandbox="allow-scripts allow-popups allow-forms allow-same-origin allow-downloads"
        onLoad={handleLoad}
        onError={handleError}
      />
      {errorUrl && (
        <div className="absolute inset-0 flex items-center justify-center bg-card/90 p-6 text-center">
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">This site could not be loaded</p>
            <p className="text-xs text-muted-foreground">
              Some websites block embedding in frames. Try opening it in your default browser.
            </p>
          </div>
        </div>
      )}
    </>
  );
});

const BrowserViewportInner = forwardRef<BrowserViewportRef, BrowserViewportProps>(
  function BrowserViewportInner(props, ref) {
    if (isWebviewTagSupported()) {
      return <WebViewViewport ref={ref} {...props} />;
    }
    return <IFrameViewport ref={ref} {...props} />;
  },
);

export const BrowserViewport = memo(BrowserViewportInner);
