export const FILE_PREVIEW_LINE_HEIGHT = 20;

export function clampPreviewTargetLine(
  targetLine: number | undefined,
  totalLines: number,
): number | null {
  if (!targetLine || !Number.isFinite(targetLine) || totalLines <= 0) {
    return null;
  }

  return Math.max(1, Math.min(targetLine, totalLines));
}

export function getPreviewScrollTop(
  targetLine: number | undefined,
  totalLines: number,
  containerHeight: number,
  lineHeight = FILE_PREVIEW_LINE_HEIGHT,
): number | null {
  const clampedLine = clampPreviewTargetLine(targetLine, totalLines);
  if (clampedLine === null) {
    return null;
  }

  return Math.max(0, clampedLine * lineHeight - containerHeight / 2);
}
