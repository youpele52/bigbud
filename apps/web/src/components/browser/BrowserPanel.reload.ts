import type { RefObject } from "react";

import type { BrowserViewportRef } from "./BrowserPanel.viewport";

export function reloadBrowserViewport(
  viewportRef: RefObject<BrowserViewportRef | null>,
  mode: "normal" | "ignoring-cache",
): void {
  if (mode === "ignoring-cache") {
    viewportRef.current?.reloadIgnoringCache();
    return;
  }
  viewportRef.current?.reload();
}
