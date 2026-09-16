import { useCallback, useLayoutEffect, useRef, useState } from "react";

import {
  measureFilePreviewLayout,
  type MarkdownReadingContext,
} from "./FilePreview.scroll.context";
import {
  captureFilePreviewAnchor,
  resolveFilePreviewScrollTop,
  resolveRelativeFilePreviewScrollTop,
} from "./FilePreview.scroll.dom";
import type { MarkdownFileViewMode } from "./FilePreview.scroll.logic";
import { observeMarkdownRestore } from "./FilePreview.scroll.restore";

interface UseMarkdownPreviewScrollInput {
  readonly fileKey: string;
  readonly contents: string;
  readonly isMarkdownFile: boolean;
  readonly ready?: boolean;
  readonly scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  readonly linesContainerRef: React.RefObject<HTMLDivElement | null>;
  readonly markdownContentRef: React.RefObject<HTMLDivElement | null>;
  readonly lineHeight: number;
  readonly totalLines: number;
  readonly onScrollPositionChange?: ((scrollTop: number) => void) | undefined;
}

export function useMarkdownPreviewScroll({
  fileKey,
  contents,
  isMarkdownFile,
  ready = true,
  scrollContainerRef,
  linesContainerRef,
  markdownContentRef,
  lineHeight,
  totalLines,
  onScrollPositionChange,
}: UseMarkdownPreviewScrollInput) {
  const [selection, setSelection] = useState({ fileKey, mode: "preview" as MarkdownFileViewMode });
  const viewMode = selection.fileKey === fileKey ? selection.mode : "preview";
  const contextRef = useRef<MarkdownReadingContext | null>(null);
  const identityRef = useRef({ fileKey, contents });
  const cleanupRef = useRef<(() => void) | null>(null);
  const expectedScrollRef = useRef<{ element: HTMLDivElement; top: number } | null>(null);
  const reportRef = useRef(onScrollPositionChange);
  useLayoutEffect(() => {
    reportRef.current = onScrollPositionChange;
  }, [onScrollPositionChange]);

  const stopObserving = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);
  const cancelPendingRestore = useCallback(() => {
    stopObserving();
    contextRef.current = null;
    expectedScrollRef.current = null;
  }, [stopObserving]);

  useLayoutEffect(() => {
    if (identityRef.current.fileKey !== fileKey) {
      setSelection({ fileKey, mode: "preview" });
    }
    if (
      identityRef.current.fileKey !== fileKey ||
      identityRef.current.contents !== contents ||
      !ready
    ) {
      cancelPendingRestore();
      identityRef.current = { fileKey, contents };
    }
  }, [cancelPendingRestore, contents, fileKey, ready]);

  const handleModeChange = useCallback(
    (nextMode: MarkdownFileViewMode) => {
      if (!isMarkdownFile || viewMode === nextMode) return;
      const container = scrollContainerRef.current;
      const root = viewMode === "preview" ? markdownContentRef.current : linesContainerRef.current;
      stopObserving();
      if (ready && container) {
        const layout = measureFilePreviewLayout(container, root);
        let context = contextRef.current;
        const snapshot = context?.snapshots[viewMode];
        // Detect synchronous movement before the browser has delivered its scroll event.
        if (snapshot && Math.abs(snapshot.scrollTop - container.scrollTop) > 0.5) context = null;
        if (!context) {
          context = {
            anchor: captureFilePreviewAnchor({
              mode: viewMode,
              container,
              linesContainer: linesContainerRef.current,
              markdownContent: markdownContentRef.current,
              lineHeight,
              totalLines,
            }),
            snapshots: {},
          };
        }
        context.snapshots[viewMode] = { scrollTop: container.scrollTop, layout };
        contextRef.current = context;
      } else contextRef.current = null;
      expectedScrollRef.current = null;
      setSelection({ fileKey, mode: nextMode });
    },
    [
      fileKey,
      isMarkdownFile,
      lineHeight,
      linesContainerRef,
      markdownContentRef,
      ready,
      scrollContainerRef,
      stopObserving,
      totalLines,
      viewMode,
    ],
  );

  useLayoutEffect(() => {
    const context = contextRef.current;
    const container = scrollContainerRef.current;
    if (!ready || !context || !container) return;
    const root = viewMode === "preview" ? markdownContentRef.current : linesContainerRef.current;
    let disposed = false;
    const restore = () => {
      if (disposed || contextRef.current !== context || scrollContainerRef.current !== container)
        return;
      const layout = measureFilePreviewLayout(container, root);
      const snapshot = context.snapshots[viewMode];
      const target =
        snapshot?.layout === layout
          ? snapshot.scrollTop
          : (resolveFilePreviewScrollTop({
              mode: viewMode,
              anchor: context.anchor,
              container,
              linesContainer: linesContainerRef.current,
              markdownContent: markdownContentRef.current,
              lineHeight,
            }) ??
            resolveRelativeFilePreviewScrollTop({
              mode: viewMode,
              anchor: context.anchor,
              container,
            }));
      container.scrollTo({ top: target, behavior: "instant" });
      expectedScrollRef.current = { element: container, top: container.scrollTop };
      context.snapshots[viewMode] = { scrollTop: container.scrollTop, layout };
    };
    const publish = () => {
      if (!disposed && scrollContainerRef.current === container)
        reportRef.current?.(container.scrollTop);
    };
    const cancel = () => {
      publish();
      cancelPendingRestore();
    };
    const cleanup = root
      ? observeMarkdownRestore({
          container,
          root,
          restore,
          publish,
          invalidateLayout: () => {
            contextRef.current = null;
          },
          cancel,
        })
      : undefined;
    restore();
    // History owns its debounce and flushes on navigation; do not add another delay here.
    publish();
    const stop = () => {
      disposed = true;
      cleanup?.();
    };
    cleanupRef.current = stop;
    return () => {
      stop();
      if (cleanupRef.current === stop) cleanupRef.current = null;
    };
  }, [
    cancelPendingRestore,
    contents,
    fileKey,
    lineHeight,
    linesContainerRef,
    markdownContentRef,
    ready,
    scrollContainerRef,
    viewMode,
  ]);

  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const container = event.currentTarget;
      if (container !== scrollContainerRef.current || !ready) return;
      const expected = expectedScrollRef.current;
      if (expected?.element === container && Math.abs(container.scrollTop - expected.top) <= 0.5)
        return;
      cancelPendingRestore();
      reportRef.current?.(container.scrollTop);
    },
    [cancelPendingRestore, ready, scrollContainerRef],
  );

  return { viewMode, handleModeChange, handleScroll, cancelPendingRestore };
}
