import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import type { BrowserViewportProps, BrowserViewportRef } from "./BrowserPanel.viewport.types";
import { BrowserPanelErrorPage } from "./BrowserPanel.errorPage";
import { iframeNavigationError } from "./BrowserPanel.navigationError";

export const BrowserIframeViewport = forwardRef<BrowserViewportRef, BrowserViewportProps>(
  function BrowserIframeViewport(
    { url, onUrlChange, onLoadStart, onLoadSuccess, onLoadFail, onPageMetadataChange },
    ref,
  ) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const onUrlChangeRef = useRef(onUrlChange);
    const onLoadStartRef = useRef(onLoadStart);
    const onLoadSuccessRef = useRef(onLoadSuccess);
    const onLoadFailRef = useRef(onLoadFail);
    const [errorUrl, setErrorUrl] = useState<string | null>(null);

    onUrlChangeRef.current = onUrlChange;
    onLoadStartRef.current = onLoadStart;
    onLoadSuccessRef.current = onLoadSuccess;
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
      reloadIgnoringCache: () => {
        const iframe = iframeRef.current;
        if (!iframe) return;
        iframe.src = url;
      },
      openDevTools: () => undefined,
      inspectElement: () => undefined,
      undo: () => undefined,
      redo: () => undefined,
      cut: () => undefined,
      copy: () => undefined,
      paste: () => undefined,
      selectAll: () => undefined,
      executeAgentAction: async () => {
        throw new Error("Visible browser automation requires the bigbud desktop app.");
      },
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
        onLoadStartRef.current?.();
        onPageMetadataChange?.({ title: "", faviconUrl: null });
      }
    }, [onPageMetadataChange, url]);

    const handleLoad = () => {
      setErrorUrl(null);
      onLoadSuccessRef.current?.();
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
          <BrowserPanelErrorPage
            content={iframeNavigationError}
            onReload={() => {
              iframeRef.current?.contentWindow?.location.reload();
            }}
          />
        )}
      </>
    );
  },
);
