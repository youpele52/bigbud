import { useCallback, useLayoutEffect, useMemo, useRef } from "react";

import {
  clampPreviewTargetLine,
  FILE_PREVIEW_LINE_HEIGHT,
  getPreviewScrollTop,
} from "./FilePreview.logic";
import { resolveFilePreviewScrollTop } from "./FilePreview.scroll.dom";
import type { MarkdownFileViewMode } from "./FilePreview.scroll.logic";

interface FilePreviewPositionInput {
  readonly fileKey: string;
  readonly contents: string;
  readonly ready: boolean;
  readonly isMarkdownFile: boolean;
  readonly mode: MarkdownFileViewMode;
  readonly totalLines: number;
  readonly targetLine?: number | undefined;
  readonly initialScrollTop?: number | null | undefined;
  readonly scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  readonly linesContainerRef: React.RefObject<HTMLDivElement | null>;
  readonly markdownContentRef: React.RefObject<HTMLDivElement | null>;
  readonly cancelPendingRestore: () => void;
  readonly onSearchMatch?: ((line: number) => void) | undefined;
}

/** One positioning owner per file visit; new navigation supersedes any mode handoff. */
export function useFilePreviewPosition({
  fileKey,
  contents,
  ready,
  isMarkdownFile,
  mode,
  totalLines,
  targetLine,
  initialScrollTop,
  scrollContainerRef,
  linesContainerRef,
  markdownContentRef,
  cancelPendingRestore,
  onSearchMatch,
}: FilePreviewPositionInput) {
  const generation = useMemo(() => ({ fileKey: fileKey, contents: contents }), [fileKey, contents]);
  const activeGeneration = useRef<typeof generation | null>(generation);
  useLayoutEffect(() => {
    activeGeneration.current = generation;
    return () => {
      activeGeneration.current = null;
    };
  }, [generation]);
  const visitRef = useRef({
    fileKey: fileKey,
    initialUsed: false,
    target: undefined as number | undefined,
  });
  const claimInitialPosition = useCallback(() => {
    if (activeGeneration.current !== generation) return;
    visitRef.current = { ...visitRef.current, fileKey: fileKey, initialUsed: true };
  }, [generation, fileKey]);

  const scrollToLine = useCallback(
    (requestedLine: number) => {
      if (activeGeneration.current !== generation || !ready) return;
      const container = scrollContainerRef.current;
      const line = clampPreviewTargetLine(requestedLine, totalLines);
      if (!container || line === null) return;
      cancelPendingRestore();
      const top = isMarkdownFile
        ? resolveFilePreviewScrollTop({
            mode: mode,
            anchor: {
              sourceLine: line,
              sourceStartLine: line,
              sourceEndLine: line,
              sourceProgress: 0,
              viewportOffset: container.clientHeight / 2 - FILE_PREVIEW_LINE_HEIGHT,
              scrollFraction: 0,
              boundary: null,
            },
            container,
            linesContainer: linesContainerRef.current,
            markdownContent: markdownContentRef.current,
            lineHeight: FILE_PREVIEW_LINE_HEIGHT,
          })
        : getPreviewScrollTop(line, totalLines, container.clientHeight);
      if (top !== null) container.scrollTo({ top, behavior: "smooth" });
    },
    [
      generation,
      ready,
      cancelPendingRestore,
      isMarkdownFile,
      linesContainerRef,
      markdownContentRef,
      mode,
      scrollContainerRef,
      totalLines,
    ],
  );

  useLayoutEffect(() => {
    if (visitRef.current.fileKey !== fileKey) {
      visitRef.current = { fileKey: fileKey, initialUsed: false, target: undefined };
    }
    const visit = visitRef.current;
    if (!ready) return;
    if (targetLine !== visit.target) {
      visit.target = targetLine;
      if (targetLine) {
        visit.initialUsed = true;
        scrollToLine(targetLine);
      }
    }
    if (visit.initialUsed) return;
    visit.initialUsed = true;
    if (initialScrollTop != null) {
      cancelPendingRestore();
      scrollContainerRef.current?.scrollTo({
        top: initialScrollTop,
        behavior: "instant",
      });
    }
  }, [
    cancelPendingRestore,
    fileKey,
    initialScrollTop,
    ready,
    scrollContainerRef,
    targetLine,
    scrollToLine,
  ]);

  const handleSearchMatch = useCallback(
    (line: number) => {
      if (activeGeneration.current !== generation || !ready) return;
      claimInitialPosition();
      cancelPendingRestore();
      onSearchMatch?.(line);
      scrollToLine(line);
    },
    [claimInitialPosition, generation, ready, cancelPendingRestore, onSearchMatch, scrollToLine],
  );

  return { claimInitialPosition, handleSearchMatch };
}
