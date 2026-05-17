import { forwardRef, memo } from "react";

import { BrowserIframeViewport } from "./BrowserPanel.viewport.iframe";
import type {
  BrowserPageMetadata,
  BrowserViewportProps,
  BrowserViewportRef,
} from "./BrowserPanel.viewport.types";
import { BrowserWebviewViewport } from "./BrowserPanel.viewport.webview";
import { isWebviewTagSupported } from "./BrowserPanel.viewport.webview.utils";

export type {
  BrowserPageMetadata,
  BrowserViewportProps,
  BrowserViewportRef,
} from "./BrowserPanel.viewport.types";

const BrowserViewportInner = forwardRef<BrowserViewportRef, BrowserViewportProps>(
  function BrowserViewportInner(props, ref) {
    if (isWebviewTagSupported()) {
      return <BrowserWebviewViewport ref={ref} {...props} />;
    }
    return <BrowserIframeViewport ref={ref} {...props} />;
  },
);

export const BrowserViewport = memo(BrowserViewportInner);
