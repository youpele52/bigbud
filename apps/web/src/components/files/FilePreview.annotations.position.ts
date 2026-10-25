export const ANNOTATION_PANEL_GAP = 8;

/** Prefer the last selected line, flip above the selection, then clamp to the viewport. */
export function annotationPanelTop({
  selectionTop,
  selectionBottom,
  panelHeight,
  viewportTop,
  viewportHeight,
}: {
  selectionTop: number;
  selectionBottom: number;
  panelHeight: number;
  viewportTop: number;
  viewportHeight: number;
}): number {
  const minTop = viewportTop + ANNOTATION_PANEL_GAP;
  const maxTop = Math.max(
    minTop,
    viewportTop + viewportHeight - panelHeight - ANNOTATION_PANEL_GAP,
  );
  const belowTop = selectionBottom + ANNOTATION_PANEL_GAP;
  if (belowTop >= minTop && belowTop <= maxTop) return belowTop;
  const aboveTop = selectionTop - panelHeight - ANNOTATION_PANEL_GAP;
  if (aboveTop >= minTop && aboveTop <= maxTop) return aboveTop;
  return Math.min(Math.max(belowTop, minTop), maxTop);
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
