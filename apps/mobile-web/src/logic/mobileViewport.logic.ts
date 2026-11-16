interface MobileViewportMeasurement {
  readonly height: number;
  readonly offsetTop: number;
  readonly scale: number;
}

/** Keep keyboard/chrome geometry separate from pinch zoom, which the browser owns. */
export function resolveMobileViewport(
  viewport: MobileViewportMeasurement,
  layoutHeight: number,
): { height: number; top: number } | null {
  if (
    !Number.isFinite(layoutHeight) ||
    layoutHeight <= 0 ||
    !Number.isFinite(viewport.height) ||
    viewport.height <= 0 ||
    !Number.isFinite(viewport.offsetTop) ||
    !Number.isFinite(viewport.scale) ||
    Math.abs(viewport.scale - 1) > 0.01
  ) {
    return null;
  }
  const height = Math.min(viewport.height, layoutHeight);
  return {
    height,
    top: Math.min(Math.max(0, viewport.offsetTop), layoutHeight - height),
  };
}
