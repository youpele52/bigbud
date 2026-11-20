/**
 * Terminal side of the translucent window material. With the app-derived (bigbud) theme, xterm
 * paints a fully transparent default background so the terminal shows exactly the tint of the
 * chat column or right panel around it. Catalog themes keep their own opaque colours.
 *
 * The WebGL renderer stays in use (no renderer downgrade); `allowTransparency` only changes how
 * glyphs are rasterised into its atlas, so it is enabled solely while this mode is active.
 */

const REDUCED_TRANSPARENCY_QUERY = "(prefers-reduced-transparency: reduce)";

/** Mirrors the CSS gate in `index.windowMaterial.css`, including the Reduce transparency fallback. */
export function isTranslucentWindowMaterialActive(): boolean {
  if (typeof document === "undefined") return false;
  const dataset = document.documentElement.dataset;
  if (dataset?.desktopShell !== "macos" || dataset.windowMaterial !== "translucent") return false;
  return !(typeof matchMedia === "function" && matchMedia(REDUCED_TRANSPARENCY_QUERY).matches);
}

/** Notifies when the Reduce transparency preference changes; returns an unsubscribe function. */
export function onReducedTransparencyChange(listener: () => void): () => void {
  if (typeof matchMedia !== "function") return () => undefined;
  const query = matchMedia(REDUCED_TRANSPARENCY_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

let colorCanvasContext: CanvasRenderingContext2D | null | undefined;

function toRgbChannels(cssColor: string): readonly [number, number, number] | null {
  if (colorCanvasContext === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    colorCanvasContext = canvas.getContext("2d", { willReadFrequently: true });
  }
  const context = colorCanvasContext;
  if (!context) return null;
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = cssColor;
  context.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
  return alpha === 0 ? null : [red, green, blue];
}

/**
 * A zero-alpha version of the opaque theme background. The RGB channels still matter: xterm uses the
 * opaque background for inverse video and contrast checks, so they must be the real theme colour.
 */
export function transparentTerminalBackground(host: HTMLElement): string | null {
  const probe = document.createElement("span");
  probe.style.cssText =
    "position:absolute;visibility:hidden;background-color:var(--background-solid)";
  host.append(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const channels = toRgbChannels(resolved);
  return channels ? `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, 0)` : null;
}
