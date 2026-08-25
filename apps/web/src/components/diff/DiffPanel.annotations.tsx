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
  readonly viewportHeight: number;
  readonly viewportWidth: number;
}

const ANNOTATION_PANEL_WIDTH = 420;
const ANNOTATION_PANEL_MARGIN = 16;

export function resolveDiffAnnotationLeft(viewportWidth: number): number {
  const availableWidth = Math.max(0, viewportWidth - ANNOTATION_PANEL_MARGIN * 2);
  const panelWidth = Math.min(ANNOTATION_PANEL_WIDTH, availableWidth);
  return Math.max(ANNOTATION_PANEL_MARGIN, (viewportWidth - panelWidth) / 2);
}

export function resolveDiffAnnotationWidth(viewportWidth: number): number {
  return Math.min(ANNOTATION_PANEL_WIDTH, Math.max(0, viewportWidth - ANNOTATION_PANEL_MARGIN * 2));
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
  const left = resolveDiffAnnotationLeft(pendingAnnotation.viewportWidth);
  const width = resolveDiffAnnotationWidth(pendingAnnotation.viewportWidth);
  const top = Math.min(
    Math.max(pendingAnnotation.anchorY, 16),
    Math.max(16, pendingAnnotation.viewportHeight - 280),
  );

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      <div className="pointer-events-auto absolute" style={{ left, top, width }}>
        <AnnotationComposerPanel
          fillContainer
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
