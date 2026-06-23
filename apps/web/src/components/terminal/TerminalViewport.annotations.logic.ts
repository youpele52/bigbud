export function resolveTerminalAnnotationOverlayPosition(input: {
  anchorX: number;
  anchorY: number;
  viewportWidth?: number;
  viewportHeight?: number;
}): { left: number; top: number } {
  const viewportWidth = input.viewportWidth ?? window.innerWidth;
  const viewportHeight = input.viewportHeight ?? window.innerHeight;
  const edgePadding = 16;
  const panelWidthWithMargin = 436;
  const panelHeightWithMargin = 280;

  return {
    left: Math.min(
      Math.max(input.anchorX, edgePadding),
      Math.max(edgePadding, viewportWidth - panelWidthWithMargin),
    ),
    top: Math.min(
      Math.max(input.anchorY, edgePadding),
      Math.max(edgePadding, viewportHeight - panelHeightWithMargin),
    ),
  };
}
