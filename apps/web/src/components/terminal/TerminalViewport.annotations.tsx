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
  const { left, top } = resolveTerminalAnnotationOverlayPosition({
    anchorX: pendingAnnotation.anchorX,
    anchorY: pendingAnnotation.anchorY,
  });
  const lineRange = {
    startLine: selection.lineStart,
    endLine: selection.lineEnd,
  };

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[200]">
      <div className="pointer-events-auto fixed" style={{ left, top }}>
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
