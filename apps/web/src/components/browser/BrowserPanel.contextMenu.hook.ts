import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserViewportProps } from "./BrowserPanel.viewport.types";

export type BrowserContextMenuAnchor =
  | { readonly kind: "center" }
  | { readonly kind: "point"; readonly x: number; readonly y: number };

export type BrowserContextMenuContext = NonNullable<
  Parameters<NonNullable<BrowserViewportProps["onContextMenu"]>>[0]
>;

export function browserContextMenuAnchorFromHostPoint(
  bounds: Pick<DOMRect, "left" | "top">,
  point: { readonly x: number; readonly y: number },
): BrowserContextMenuAnchor {
  return {
    kind: "point",
    x: point.x - bounds.left,
    y: point.y - bounds.top,
  };
}

export function toggleCenteredBrowserContextMenuAnchor(
  current: BrowserContextMenuAnchor | null,
): BrowserContextMenuAnchor | null {
  return current ? null : { kind: "center" };
}

export function useBrowserContextMenu(available: boolean) {
  const boundaryRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<BrowserContextMenuAnchor | null>(null);
  const [context, setContext] = useState<BrowserContextMenuContext | null>(null);

  const close = useCallback(() => {
    setAnchor(null);
    setContext(null);
  }, []);
  const toggleCentered = useCallback(() => setAnchor(toggleCenteredBrowserContextMenuAnchor), []);
  const openAtHostPoint = useCallback((point: BrowserContextMenuContext) => {
    const bounds = boundaryRef.current?.getBoundingClientRect();
    if (bounds) {
      setAnchor(browserContextMenuAnchorFromHostPoint(bounds, point));
      setContext(point);
    }
  }, []);

  useEffect(() => {
    if (!available) close();
  }, [available, close]);

  return { anchor, boundaryRef, close, context, openAtHostPoint, toggleCentered };
}
