import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AnnotationComposerPanel,
  formatAnnotationTargetLabel,
} from "../annotations/AnnotationComposerPanel";
import type { AnnotationIntent } from "../../stores/composer";
import type { TerminalContextSelection } from "~/lib/terminalContext";
import { resolveTerminalAnnotationOverlayPosition } from "./TerminalViewport.annotations.logic";

export interface PendingTerminalAnnotation {
  readonly selection: TerminalContextSelection;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly selectionRect: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  } | null;
}

interface TerminalViewportAnnotationComposerProps {
  pendingAnnotation: PendingTerminalAnnotation;
  onCreateAnnotation: (input: {
    intent: AnnotationIntent;
    comment: string;
    selection: TerminalContextSelection;
  }) => void;
  onCancel: () => void;
}

export function TerminalViewportAnnotationComposer({
  pendingAnnotation,
  onCreateAnnotation,
  onCancel,
}: TerminalViewportAnnotationComposerProps) {
  const { selection } = pendingAnnotation;
  const panelRef = useRef<HTMLDivElement>(null);
  const fallbackPosition = resolveTerminalAnnotationOverlayPosition({
    anchorX: pendingAnnotation.anchorX,
    anchorY: pendingAnnotation.anchorY,
  });
  const [position, setPosition] = useState(fallbackPosition);
  const lineRange = {
    startLine: selection.lineStart,
    endLine: selection.lineEnd,
  };

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const selectionRect = pendingAnnotation.selectionRect;
    if (!panel || selectionRect === null) {
      setPosition(fallbackPosition);
      return;
    }

    const nextPosition = resolveTerminalAnnotationOverlayPosition({
      anchorX: pendingAnnotation.anchorX,
      anchorY: pendingAnnotation.anchorY,
      selectionRect,
      panelWidth: panel.getBoundingClientRect().width,
      panelHeight: panel.getBoundingClientRect().height,
    });
    setPosition(nextPosition);
  }, [fallbackPosition, pendingAnnotation]);

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[200]">
      <div ref={panelRef} className="pointer-events-auto fixed" style={position}>
        <AnnotationComposerPanel
          targetLabel={formatAnnotationTargetLabel(lineRange)}
          onCancel={onCancel}
          onSubmit={({ intent, comment }) => {
            onCreateAnnotation({ intent, comment, selection });
            onCancel();
          }}
        />
      </div>
    </div>,
    document.body,
  );
}
