import { ipcRenderer, webFrame } from "electron";

/**
 * Watches this window's page zoom from the preload. Every zoom source (menu, pinch, Ctrl+scroll,
 * a zoom restored on load) resizes the viewport, so a resize is the one place to notice it. On a
 * change it tells the main process, which reads the zoom itself to move the traffic lights, and
 * notifies the renderer's listeners.
 */
export function createWindowZoomObserver(changedChannel: string) {
  const listeners = new Set<(zoomFactor: number) => void>();
  let current = webFrame.getZoomFactor();

  const check = () => {
    const next = webFrame.getZoomFactor();
    if (next === current) return;
    current = next;
    ipcRenderer.send(changedChannel);
    for (const listener of listeners) listener(next);
  };
  window.addEventListener("resize", check);
  window.addEventListener("DOMContentLoaded", check);

  return {
    getWindowZoomFactor: () => current,
    onWindowZoomFactorChange: (listener: (zoomFactor: number) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
