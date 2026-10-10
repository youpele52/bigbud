import {
  FILE_PREVIEW_MIN_WIDTH,
  FILES_TREE_MAX_WIDTH_FACTOR,
  FILES_TREE_MIN_WIDTH,
  FILES_TREE_SEPARATOR_WIDTH,
} from "./FilesPanel.shared";

/** Uses the same responsive split limits for rendering, resizing, and accessibility. */
export function getFilesTreeWidthBounds(containerWidth: number) {
  const max = Math.max(
    0,
    Math.min(
      containerWidth * FILES_TREE_MAX_WIDTH_FACTOR,
      Math.max(
        FILES_TREE_MIN_WIDTH,
        containerWidth - FILE_PREVIEW_MIN_WIDTH - FILES_TREE_SEPARATOR_WIDTH,
      ),
    ),
  );
  return { min: Math.min(FILES_TREE_MIN_WIDTH, max), max };
}

export function clampFilesTreeWidth(width: number, containerWidth: number) {
  const bounds = getFilesTreeWidthBounds(containerWidth);
  return Math.max(bounds.min, Math.min(bounds.max, width));
}
