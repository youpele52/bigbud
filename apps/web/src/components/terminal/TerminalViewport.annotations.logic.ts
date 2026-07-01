export function resolveTerminalAnnotationOverlayPosition(input: {
  anchorX: number;
  anchorY: number;
  selectionRect?: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  } | null;
  panelWidth?: number;
  panelHeight?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}): { left: number; top: number } {
  const viewportWidth = input.viewportWidth ?? window.innerWidth;
  const viewportHeight = input.viewportHeight ?? window.innerHeight;
  const edgePadding = 16;
  const panelWidthWithMargin = Math.ceil((input.panelWidth ?? 420) + edgePadding);
  const panelHeightWithMargin = Math.ceil((input.panelHeight ?? 264) + edgePadding);
  const clampedLeft = Math.min(
    Math.max(input.anchorX, edgePadding),
    Math.max(edgePadding, viewportWidth - panelWidthWithMargin),
  );
  const fallbackTop = Math.min(
    Math.max(input.anchorY, edgePadding),
    Math.max(edgePadding, viewportHeight - panelHeightWithMargin),
  );

  if (input.selectionRect === undefined || input.selectionRect === null) {
    return {
      left: clampedLeft,
      top: fallbackTop,
    };
  }

  const preferredBelowTop = Math.round(input.selectionRect.bottom + 8);
  if (preferredBelowTop + panelHeightWithMargin <= viewportHeight) {
    return {
      left: clampedLeft,
      top: Math.max(edgePadding, preferredBelowTop),
    };
  }

  const preferredAboveTop = Math.round(input.selectionRect.top - (input.panelHeight ?? 264) - 8);
  if (preferredAboveTop >= edgePadding) {
    return {
      left: clampedLeft,
      top: preferredAboveTop,
    };
  }

  return {
    left: clampedLeft,
    top: fallbackTop,
  };
}
