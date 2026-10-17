import { useCallback, useLayoutEffect, useState, type RefObject } from "react";

import {
  FILES_TREE_DEFAULT_WIDTH,
  FILES_TREE_MIN_WIDTH,
  FILES_TREE_WIDTH_STORAGE_KEY,
} from "./FilesPanel.shared";
import { clampFilesTreeWidth, getFilesTreeWidthBounds } from "./FilesPanel.treeWidth.logic";

export function useFilesTreeWidth(containerRef: RefObject<HTMLDivElement | null>) {
  const [containerWidth, setContainerWidth] = useState(0);
  const [fileTreeWidth, setFileTreeWidth] = useState(() => {
    const stored = Number.parseInt(localStorage.getItem(FILES_TREE_WIDTH_STORAGE_KEY) ?? "", 10);
    return Number.isFinite(stored) && stored >= FILES_TREE_MIN_WIDTH
      ? stored
      : FILES_TREE_DEFAULT_WIDTH;
  });

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => setContainerWidth(container.getBoundingClientRect().width);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef]);

  const resizeTreeWidth = useCallback(
    (containerWidth: number, startWidth: number, deltaX: number) => {
      const newWidth = clampFilesTreeWidth(startWidth - deltaX, containerWidth);
      setFileTreeWidth(newWidth);
      localStorage.setItem(FILES_TREE_WIDTH_STORAGE_KEY, String(newWidth));
    },
    [],
  );

  return {
    renderedTreeWidth: clampFilesTreeWidth(fileTreeWidth, containerWidth),
    treeWidthBounds: getFilesTreeWidthBounds(containerWidth),
    resizeTreeWidth,
  };
}
