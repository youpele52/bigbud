import { useCallback, useState } from "react";

import {
  FILES_TREE_DEFAULT_WIDTH,
  FILES_TREE_MAX_WIDTH_FACTOR,
  FILES_TREE_MIN_WIDTH,
  FILES_TREE_WIDTH_STORAGE_KEY,
} from "./FilesPanel.shared";

export function useFilesTreeWidth() {
  const [fileTreeWidth, setFileTreeWidth] = useState(() => {
    const stored = Number.parseInt(localStorage.getItem(FILES_TREE_WIDTH_STORAGE_KEY) ?? "", 10);
    return Number.isFinite(stored) && stored >= FILES_TREE_MIN_WIDTH
      ? stored
      : FILES_TREE_DEFAULT_WIDTH;
  });

  const resizeTreeWidth = useCallback(
    (containerWidth: number, startWidth: number, deltaX: number) => {
      const maxWidth = containerWidth * FILES_TREE_MAX_WIDTH_FACTOR;
      const newWidth = Math.max(FILES_TREE_MIN_WIDTH, Math.min(maxWidth, startWidth - deltaX));
      setFileTreeWidth(newWidth);
      localStorage.setItem(FILES_TREE_WIDTH_STORAGE_KEY, String(newWidth));
    },
    [],
  );

  return { fileTreeWidth, resizeTreeWidth };
}
