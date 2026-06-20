import {
  AnnotationComposerPanel,
  formatAnnotationTargetLabel,
} from "../annotations/AnnotationComposerPanel";
import type { CodeAnnotationDraft } from "../files/FilePreview";
import type { DiffSelectionRange } from "./diffSelection.logic";

export interface PendingDiffAnnotation {
  readonly filePath: string;
  readonly range: DiffSelectionRange;
  readonly selectedText: string;
  readonly anchorX: number;
  readonly anchorY: number;
}

interface DiffPanelAnnotationComposerProps {
  pendingAnnotation: PendingDiffAnnotation;
  onCreateAnnotation: (annotation: CodeAnnotationDraft) => void;
  onCancel: () => void;
}

export function DiffPanelAnnotationComposer({
  pendingAnnotation,
  onCreateAnnotation,
  onCancel,
}: DiffPanelAnnotationComposerProps) {
  const left = Math.min(
    Math.max(pendingAnnotation.anchorX, 16),
    Math.max(16, window.innerWidth - 436),
  );
  const top = Math.min(
    Math.max(pendingAnnotation.anchorY, 16),
    Math.max(16, window.innerHeight - 280),
  );

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      <div className="pointer-events-auto absolute" style={{ left, top }}>
        <AnnotationComposerPanel
          targetLabel={formatAnnotationTargetLabel(pendingAnnotation.range)}
          onCancel={onCancel}
          onSubmit={({ intent, comment }) => {
            onCreateAnnotation({
              intent,
              comment,
              startLine: pendingAnnotation.range.startLine,
              endLine: pendingAnnotation.range.endLine,
              text: pendingAnnotation.selectedText,
            });
            onCancel();
          }}
        />
      </div>
    </div>
  );
}
