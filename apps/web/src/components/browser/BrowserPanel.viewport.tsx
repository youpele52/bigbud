import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from "react";
import { isElectron } from "~/config/env";
import {
  browserAnnotationCancelScript,
  browserAnnotationCleanupScript,
  browserAnnotationPrepareCaptureScript,
  browserAnnotationPickerScript,
  type BrowserAnnotationResult,
  type BrowserAnnotationSelection,
  type BrowserAnnotationTheme,
} from "./BrowserPanel.annotation";

export interface BrowserViewportRef {
  goBack(): void;
  goForward(): void;
  reload(): void;
  openDevTools(): void;
  startAnnotation(): Promise<BrowserAnnotationResult | null>;
  cancelAnnotation(): Promise<void>;
}

export interface BrowserPageMetadata {
  title: string;
  faviconUrl: string | null;
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
  onPageMetadataChange?: ((metadata: BrowserPageMetadata) => void) | undefined;
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
  executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>;
  capturePage(): Promise<{ toDataURL(): string }>;
};

type NavigateEvent = Event & { url: string };
type PageTitleEvent = Event & { title?: string };
type PageFaviconEvent = Event & { favicons?: string[] };
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

const browserSameTabPopupGuardScript = String.raw`(() => {
  const navigateCurrentTab = (rawUrl) => {
    if (typeof rawUrl !== "string" || rawUrl.length === 0) {
      return false;
    }

    try {
      const nextUrl = new URL(rawUrl, window.location.href).toString();
      window.location.assign(nextUrl);
      return true;
    } catch {
      return false;
    }
  };

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) {
        return;
      }

      const targetValue = anchor.getAttribute("target");
      if (targetValue !== "_blank") {
        return;
      }

      if (!navigateCurrentTab(anchor.href)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );

  const originalWindowOpen = window.open.bind(window);
  window.open = function patchedWindowOpen(url, target, features) {
    if (typeof target === "string" && target.length > 0 && target !== "_self" && target !== "_top") {
      if (navigateCurrentTab(String(url ?? ""))) {
        return window;
      }
    }

    if (navigateCurrentTab(String(url ?? ""))) {
      return window;
    }

    return originalWindowOpen(url, target, features);
  };
})();`;

/** Probe a CSS value by rendering a hidden element with that value as a specific
 *  CSS property, then reading back the computed colour. This correctly resolves
 *  var() chains for both `color` and `background-color` tokens. */
function probeColor(cssValue: string, property: "color" | "backgroundColor"): string {
  if (typeof document === "undefined") return cssValue;
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.pointerEvents = "none";
  probe.style.visibility = "hidden";
  if (property === "color") {
    probe.style.color = cssValue;
  } else {
    probe.style.backgroundColor = cssValue;
  }
  document.body.appendChild(probe);
  const resolved =
    property === "color" ? getComputedStyle(probe).color : getComputedStyle(probe).backgroundColor;
  probe.remove();
  // Reject transparent fallbacks — they mean the value didn't resolve.
  if (!resolved || resolved === "rgba(0, 0, 0, 0)" || resolved === "transparent") return cssValue;
  return resolved;
}

/** Read a concrete (non-transparent) computed style from a DOM element, or
 *  return undefined if the element is absent or the value is transparent. */
function readElementColor(
  element: Element | null,
  property: "backgroundColor" | "borderColor" | "color",
): string | undefined {
  if (!element) return undefined;
  const value = getComputedStyle(element)[property];
  return value && value !== "rgba(0, 0, 0, 0)" && value !== "transparent" ? value : undefined;
}

function readAnnotationTheme(): BrowserAnnotationTheme {
  const styles = getComputedStyle(document.documentElement);

  // Try to read concrete colours from live composer DOM elements.
  const composerForm = document.querySelector('[data-chat-composer-form="true"]');
  // The composer surface is the bg-card div inside the form.
  const composerSurface = composerForm?.querySelector(".bg-card") ?? composerForm ?? null;
  // The composer editor element carries the text foreground colour.
  const composerEditor = composerForm?.querySelector('[data-testid="composer-editor"]') ?? null;
  // The primary send button — select by type=submit since Tailwind class names can vary.
  const composerSendButton =
    composerForm?.querySelector<HTMLButtonElement>("button[type=submit]") ??
    composerForm?.querySelector<HTMLButtonElement>("button.bg-primary\\/90") ??
    null;

  // Fallback: resolve via probe elements using the CSS variable values.
  const rawCard = styles.getPropertyValue("--card").trim() || "var(--color-white)";
  const rawFg = styles.getPropertyValue("--foreground").trim() || "var(--color-neutral-900)";
  const rawBorder = styles.getPropertyValue("--border").trim() || "rgba(0,0,0,0.08)";
  const rawInput = styles.getPropertyValue("--input").trim() || "rgba(0,0,0,0.1)";
  const rawMuted = styles.getPropertyValue("--muted-foreground").trim() || "#737373";
  const rawPrimary = styles.getPropertyValue("--primary").trim() || "var(--brand-primary-dark)";
  const rawPrimaryFg =
    styles.getPropertyValue("--primary-foreground").trim() || "var(--brand-primary-light)";
  const rawInfo = styles.getPropertyValue("--info-foreground").trim() || "#1d4ed8";
  const rawRing = styles.getPropertyValue("--ring").trim() || "var(--foreground)";

  return {
    card:
      readElementColor(composerSurface, "backgroundColor") ??
      probeColor(rawCard, "backgroundColor"),
    foreground: readElementColor(composerEditor, "color") ?? probeColor(rawFg, "color"),
    border: readElementColor(composerSurface, "borderColor") ?? probeColor(rawBorder, "color"),
    input: probeColor(rawInput, "backgroundColor"),
    mutedForeground: probeColor(rawMuted, "color"),
    primary:
      readElementColor(composerSendButton, "backgroundColor") ??
      probeColor(rawPrimary, "backgroundColor"),
    primaryForeground:
      readElementColor(composerSendButton, "color") ?? probeColor(rawPrimaryFg, "color"),
    infoForeground: probeColor(rawInfo, "color"),
    ring: probeColor(rawRing, "color"),
  };
}

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

function normalizeBrowserUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).toString();
  } catch {
    return null;
  }
}

const WebViewViewport = forwardRef<BrowserViewportRef, BrowserViewportProps>(
  function WebViewViewport(
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
    const urlRef = useRef(url);
    const pageMetadataRef = useRef<BrowserPageMetadata>({ title: "", faviconUrl: null });
    const annotationActiveRef = useRef(false);

    onUrlChangeRef.current = onUrlChange;
    onNavigationStateChangeRef.current = onNavigationStateChange;
    onLoadFailRef.current = onLoadFail;
    onPageMetadataChangeRef.current = onPageMetadataChange;
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
      cancelAnnotation: async () => {
        const w = webviewRef.current;
        if (!w || !annotationActiveRef.current) return;
        annotationActiveRef.current = false;
        await w.executeJavaScript(`(${browserAnnotationCancelScript.toString()})()`, false);
      },
      startAnnotation: async () => {
        const w = webviewRef.current;
        if (!w || !readyRef.current) return null;
        const theme = JSON.stringify(readAnnotationTheme());
        annotationActiveRef.current = true;
        const selection = await w.executeJavaScript<BrowserAnnotationSelection>(
          `(${browserAnnotationPickerScript.toString()})(${theme})`,
          true,
        );
        annotationActiveRef.current = false;
        if (!selection || selection.cancelled) return null;

        try {
          await w.executeJavaScript(
            `(${browserAnnotationPrepareCaptureScript.toString()})()`,
            false,
          );
          const screenshot = await w.capturePage();
          return {
            comment: selection.comment,
            page: {
              url: w.getURL(),
              title: w.getTitle(),
            },
            element: selection.element,
            viewport: selection.viewport,
            screenshot: {
              mime: "image/png",
              dataUrl: screenshot.toDataURL(),
            },
          };
        } finally {
          void w
            .executeJavaScript(`(${browserAnnotationCleanupScript.toString()})()`, false)
            .catch(() => {
              // Ignore transient cleanup failures after capture.
            });
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
        const w = webviewRef.current;
        if (!w || !isWebviewReady(w)) return;
        try {
          updatePageMetadata({ title: w.getTitle() || "" });
        } catch {
          // Guest frame may not be ready yet; ignore transient state reads.
        }
        void w
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
        const w = webviewRef.current;
        if (!w || !isWebviewReady(w)) return;
        void w.executeJavaScript(browserSameTabPopupGuardScript, false).catch(() => {
          // Ignore transient script-injection failures during navigation.
        });
      };

      const handleNavigate = (e: NavigateEvent) => {
        updateNavState();
        if (e.url) {
          try {
            onUrlChangeRef.current?.(e.url);
            updatePageMetadata({ title: "", faviconUrl: null });
          } catch {
            // Ignore transient callback errors during navigation.
          }
        }
      };

      const handlePageTitle = (e: PageTitleEvent) => {
        updatePageMetadata({ title: e.title || "" });
      };

      const handlePageFavicon = (e: PageFaviconEvent) => {
        updatePageMetadata({ faviconUrl: e.favicons?.[0] ?? null });
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
  { url, onUrlChange, onLoadFail, onPageMetadataChange },
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
    startAnnotation: async () => null,
    cancelAnnotation: async () => undefined,
  }));

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const currentSrc = iframe.getAttribute("src");
    if (currentSrc !== url) {
      iframe.setAttribute("src", url);
      setErrorUrl(null);
      onPageMetadataChange?.({ title: "", faviconUrl: null });
    }
  }, [onPageMetadataChange, url]);

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
        sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"
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
