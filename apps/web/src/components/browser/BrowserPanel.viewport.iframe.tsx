import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import type { BrowserViewportProps, BrowserViewportRef } from "./BrowserPanel.viewport.types";

export const BrowserIframeViewport = forwardRef<BrowserViewportRef, BrowserViewportProps>(
  function BrowserIframeViewport({ url, onUrlChange, onLoadFail, onPageMetadataChange }, ref) {
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
      reloadIgnoringCache: () => {
        const iframe = iframeRef.current;
        if (!iframe) return;
        iframe.src = url;
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
  },
);
