import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import type { BrowserViewportProps, BrowserViewportRef } from "./BrowserPanel.viewport.types";
import { BrowserPanelErrorPage } from "./BrowserPanel.errorPage";
import { iframeNavigationError } from "./BrowserPanel.navigationError";
import { BrowserExternalLink } from "./BrowserPanel.externalLink";

export const BrowserIframeViewport = forwardRef<BrowserViewportRef, BrowserViewportProps>(
  function BrowserIframeViewport(
    {
      url,
      onUrlChange,
      onNavigationCommit,
      onLoadStart,
      onLoadSuccess,
      onLoadFail,
      onPageMetadataChange,
    },
    ref,
  ) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const onUrlChangeRef = useRef(onUrlChange);
    const onNavigationCommitRef = useRef(onNavigationCommit);
    const onLoadStartRef = useRef(onLoadStart);
    const onLoadSuccessRef = useRef(onLoadSuccess);
    const onLoadFailRef = useRef(onLoadFail);
    const requestedUrlRef = useRef<string | null>(null);
    const [errorUrl, setErrorUrl] = useState<string | null>(null);

    onUrlChangeRef.current = onUrlChange;
    onNavigationCommitRef.current = onNavigationCommit;
    onLoadStartRef.current = onLoadStart;
    onLoadSuccessRef.current = onLoadSuccess;
    onLoadFailRef.current = onLoadFail;

    const reloadIframe = () => {
      const iframe = iframeRef.current;
      if (!iframe) return;
      onLoadStartRef.current?.();
      try {
        iframe.contentWindow?.location.reload();
      } catch {
        iframe.src = url;
      }
    };

    useImperativeHandle(ref, () => ({
      goBack: () => undefined,
      goForward: () => undefined,
      reload: reloadIframe,
      reloadIgnoringCache: () => {
        const iframe = iframeRef.current;
        if (!iframe) return;
        onLoadStartRef.current?.();
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
      if (requestedUrlRef.current !== url) {
        requestedUrlRef.current = url;
        iframe.setAttribute("src", url);
        setErrorUrl(null);
        onLoadStartRef.current?.();
        onPageMetadataChange?.({ title: "", faviconUrl: null });
      }
    }, [onPageMetadataChange, url]);

    const handleLoad = () => {
      setErrorUrl(null);
      onLoadSuccessRef.current?.();
      onNavigationCommitRef.current?.(url);
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
      <div className="absolute inset-0 flex flex-col">
        <iframe
          key={url}
          ref={iframeRef}
          src={url}
          className="min-h-0 w-full flex-1 border-0"
          title="Browser"
          sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"
          onLoad={handleLoad}
          onError={handleError}
        />
        {errorUrl === url && (
          <BrowserPanelErrorPage
            content={iframeNavigationError}
            onReload={reloadIframe}
            externalUrl={url}
          />
        )}
        <div
          className="z-10 shrink-0 border-t border-border bg-background p-2 text-xs text-muted-foreground"
          role="note"
        >
          Some sites block embedded pages or sign-in, even when loading appears complete. No sign-in
          state is transferred. <BrowserExternalLink url={url} />
        </div>
      </div>
    );
  },
);
