export const ANNOTATION_PANEL_GAP = 8;

/** Prefer the requested side, flip when needed, then clamp to the viewport. */
export function annotationPanelTop({
  selectionTop,
  selectionBottom,
  panelHeight,
  viewportTop,
  viewportHeight,
  preferredSide = "below",
}: {
  selectionTop: number;
  selectionBottom: number;
  panelHeight: number;
  viewportTop: number;
  viewportHeight: number;
  preferredSide?: "above" | "below";
}): number {
  const minTop = viewportTop + ANNOTATION_PANEL_GAP;
  const maxTop = Math.max(
    minTop,
    viewportTop + viewportHeight - panelHeight - ANNOTATION_PANEL_GAP,
  );
  const belowTop = selectionBottom + ANNOTATION_PANEL_GAP;
  const aboveTop = selectionTop - panelHeight - ANNOTATION_PANEL_GAP;
  const preferredTop = preferredSide === "above" ? aboveTop : belowTop;
  const fallbackTop = preferredSide === "above" ? belowTop : aboveTop;
  if (preferredTop >= minTop && preferredTop <= maxTop) return preferredTop;
  if (fallbackTop >= minTop && fallbackTop <= maxTop) return fallbackTop;
  return Math.min(Math.max(preferredTop, minTop), maxTop);
}

/** Measure text endpoints rather than block boxes, which can span many wrapped lines. */
export function renderedSelectionBounds(range: Range): { top: number; bottom: number } | null {
  if (!range.startContainer.isConnected || !range.endContainer.isConnected || range.collapsed) {
    return null;
  }
  const first = range.cloneRange();
  first.setEnd(range.startContainer, range.startOffset + 1);
  const last = range.cloneRange();
  last.setStart(range.endContainer, range.endOffset - 1);
  return { top: first.getBoundingClientRect().top, bottom: last.getBoundingClientRect().bottom };
}
