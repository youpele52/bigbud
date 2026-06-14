import { useLayoutEffect, useRef, useState } from "react";

import {
  AnnotationComposerPanel,
  formatAnnotationTargetLabel,
} from "../annotations/AnnotationComposerPanel";
import type { CodeAnnotationDraft } from "./FilePreview";
import { FILE_PREVIEW_LINE_HEIGHT } from "./FilePreview.logic";

interface FilePreviewAnnotationComposerProps {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  linesContainerRef: React.RefObject<HTMLDivElement | null>;
  selectedRange: { startLine: number; endLine: number };
  selectedText: string;
  onCreateAnnotation: (annotation: CodeAnnotationDraft) => void;
  onCancel: () => void;
}

const PANEL_GAP_PX = 8;

export function FilePreviewAnnotationComposer({
  scrollContainerRef,
  linesContainerRef,
  selectedRange,
  selectedText,
  onCreateAnnotation,
  onCancel,
}: FilePreviewAnnotationComposerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelTop, setPanelTop] = useState<number | null>(null);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    const linesContainer = linesContainerRef.current;
    if (!container || !linesContainer) return;

    const linesTop = linesContainer.offsetTop;
    const belowTop = linesTop + selectedRange.endLine * FILE_PREVIEW_LINE_HEIGHT + PANEL_GAP_PX;

    const panel = panelRef.current;
    if (!panel) {
      setPanelTop(belowTop);
      return;
    }

    const panelHeight = panel.getBoundingClientRect().height;
    const visibleBottom = container.scrollTop + container.clientHeight;

    if (belowTop + panelHeight > visibleBottom) {
      const aboveTop =
        linesTop +
        (selectedRange.startLine - 1) * FILE_PREVIEW_LINE_HEIGHT -
        panelHeight -
        PANEL_GAP_PX;
      if (aboveTop >= container.scrollTop) {
        setPanelTop(aboveTop);
        return;
      }
    }

    setPanelTop(belowTop);
  }, [scrollContainerRef, linesContainerRef, selectedRange]);

  return (
    <div
      ref={panelRef}
      className="absolute left-1/2 z-10 -translate-x-1/2"
      style={{ top: panelTop ?? 0 }}
    >
      <AnnotationComposerPanel
        targetLabel={formatAnnotationTargetLabel(selectedRange)}
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
    </div>
  );
}
