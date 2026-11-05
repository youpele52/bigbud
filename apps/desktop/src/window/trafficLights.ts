/**
 * macOS traffic light placement. The buttons are native, so page zoom does not move or scale
 * them, while the web title bar (52px tall) scales with zoom. Repositioning them for each zoom
 * factor keeps them centred in the title bar, the way other desktop chat apps do.
 */
export const TITLE_BAR_HEIGHT_PX = 52;
const TRAFFIC_LIGHTS_X = 16;
/** Half the height of the button row, so its centre meets the title bar's centre. */
const TRAFFIC_LIGHTS_HALF_HEIGHT = 7;
const MIN_ZOOM_FACTOR = 0.25;
const MAX_ZOOM_FACTOR = 5;

export function trafficLightPositionForZoom(zoomFactor: number): { x: number; y: number } {
  const zoom = Number.isFinite(zoomFactor)
    ? Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, zoomFactor))
    : 1;
  const titleBarCentre = (TITLE_BAR_HEIGHT_PX / 2) * zoom;
  return {
    x: TRAFFIC_LIGHTS_X,
    y: Math.max(0, Math.round(titleBarCentre - TRAFFIC_LIGHTS_HALF_HEIGHT)),
  };
}

interface ZoomableWindow {
  isDestroyed(): boolean;
  setWindowButtonPosition(position: { x: number; y: number }): void;
  readonly webContents: {
    getZoomFactor(): number;
    on(event: "did-finish-load", listener: () => void): unknown;
    readonly ipc: { on(channel: string, listener: () => void): unknown };
  };
}

/**
 * Keeps a macOS window's traffic lights centred in its zoomed title bar: on load (a zoom may be
 * restored) and whenever its own page reports a zoom change. The zoom is read from the window, not
 * the message, and the IPC is scoped to this window's page, so browser guests cannot move them.
 */
export function bindTrafficLightsToZoom(
  window: ZoomableWindow,
  zoomChangedChannel: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "darwin") return;
  const sync = () => {
    if (window.isDestroyed()) return;
    window.setWindowButtonPosition(trafficLightPositionForZoom(window.webContents.getZoomFactor()));
  };
  window.webContents.ipc.on(zoomChangedChannel, sync);
  window.webContents.on("did-finish-load", sync);
}
