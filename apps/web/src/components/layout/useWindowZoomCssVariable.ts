import type { DesktopBridge } from "@bigbud/contracts/server/ipc.ts";
import { useEffect } from "react";

/** CSS custom property holding the desktop window's page zoom factor (1 is actual size). */
export const WINDOW_ZOOM_CSS_VARIABLE = "--window-zoom";

type WindowZoomBridge = Pick<DesktopBridge, "getWindowZoomFactor" | "onWindowZoomFactorChange">;

const normalizeZoomFactor = (zoomFactor: number) =>
  Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;

/**
 * Keeps `--window-zoom` on `root` in step with the window's page zoom. Returns a cleanup that
 * stops listening and removes the variable, which then falls back to 1.
 */
export function syncWindowZoomCssVariable(
  bridge: WindowZoomBridge | undefined,
  root: { readonly style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty"> },
): () => void {
  if (!bridge?.getWindowZoomFactor) return () => undefined;
  const apply = (zoomFactor: number) =>
    root.style.setProperty(WINDOW_ZOOM_CSS_VARIABLE, String(normalizeZoomFactor(zoomFactor)));
  apply(bridge.getWindowZoomFactor());
  const unsubscribe = bridge.onWindowZoomFactorChange?.(apply);
  return () => {
    unsubscribe?.();
    root.style.removeProperty(WINDOW_ZOOM_CSS_VARIABLE);
  };
}

/**
 * Mirrors the desktop window's page zoom into `--window-zoom`, so title bar positions written in
 * window points stay next to the native traffic lights at any zoom. A no-op outside the desktop
 * app.
 */
export function useWindowZoomCssVariable() {
  useEffect(() => syncWindowZoomCssVariable(window.desktopBridge, document.documentElement), []);
}
