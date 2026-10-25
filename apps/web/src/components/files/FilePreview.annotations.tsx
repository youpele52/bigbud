import { useLayoutEffect, useRef, useState } from "react";

import {
  AnnotationComposerPanel,
  formatAnnotationTargetLabel,
} from "../annotations/AnnotationComposerPanel";
import type { CodeAnnotationDraft } from "./FilePreview";
import { FILE_PREVIEW_LINE_HEIGHT } from "./FilePreview.logic";
import {
  ANNOTATION_PANEL_GAP,
  annotationPanelTop,
  renderedSelectionBounds,
} from "./FilePreview.annotations.position";

interface FilePreviewAnnotationComposerProps {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  linesContainerRef: React.RefObject<HTMLDivElement | null>;
  selectedRange: { startLine: number; endLine: number };
  selectedText: string;
  renderedRange?: Range | undefined;
  onCreateAnnotation: (annotation: CodeAnnotationDraft) => void;
  onCancel: () => void;
}

export function FilePreviewAnnotationComposer({
  scrollContainerRef,
  linesContainerRef,
  selectedRange,
  selectedText,
  renderedRange,
  onCreateAnnotation,
  onCancel,
}: FilePreviewAnnotationComposerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, maxHeight: 0 });

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    const linesContainer = linesContainerRef.current;
    const panel = panelRef.current;
    if (!container || !linesContainer || !panel) return;

    const updatePosition = () => {
      const bounds = renderedRange ? renderedSelectionBounds(renderedRange) : null;
      const contentOffset =
        container.scrollTop - container.getBoundingClientRect().top - container.clientTop;
      const linesTop = linesContainer.offsetTop;
      const maxHeight = Math.max(0, container.clientHeight - ANNOTATION_PANEL_GAP * 2);
      const top = annotationPanelTop({
        selectionTop: bounds
          ? bounds.top + contentOffset
          : linesTop + (selectedRange.startLine - 1) * FILE_PREVIEW_LINE_HEIGHT,
        selectionBottom: bounds
          ? bounds.bottom + contentOffset
          : linesTop + selectedRange.endLine * FILE_PREVIEW_LINE_HEIGHT,
        panelHeight: Math.min(panel.getBoundingClientRect().height, maxHeight),
        viewportTop: container.scrollTop,
        viewportHeight: container.clientHeight,
      });
      setPosition((current) =>
        current.top === top && current.maxHeight === maxHeight ? current : { top, maxHeight },
      );
    };
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    observer.observe(container);
    observer.observe(linesContainer);
    observer.observe(panel);
    container.addEventListener("scroll", updatePosition, { passive: true });
    return () => {
      observer.disconnect();
      container.removeEventListener("scroll", updatePosition);
    };
  }, [renderedRange, scrollContainerRef, linesContainerRef, selectedRange]);

  const panel = (
    <AnnotationComposerPanel
      targetLabel={formatAnnotationTargetLabel(selectedRange)}
      fillContainer
      selectionPreview={selectedText}
      onCancel={onCancel}
      onSubmit={({ intent, comment }) => {
        onCreateAnnotation({
          intent,
          comment,
          startLine: selectedRange.startLine,
          endLine: selectedRange.endLine,
          text: selectedText,
        });
        onCancel();
      }}
    />
  );

  return (
    <div
      ref={panelRef}
      className="absolute left-1/2 z-10 -translate-x-1/2 overflow-auto rounded-[20px] shadow-[0_18px_54px_rgba(0,0,0,0.24)]"
      style={{
        top: position.top,
        maxHeight: position.maxHeight || undefined,
        width: "min(420px, calc(100% - 16px))",
      }}
    >
      {panel}
    </div>
  );
}
