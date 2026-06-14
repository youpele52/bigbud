import type { Dispatch, SetStateAction } from "react";

import {
  AnnotationComposerPanel,
  formatAnnotationTargetLabel,
} from "../annotations/AnnotationComposerPanel";
import { type CodeAnnotationDraft } from "./FilePreview";

interface LineRange {
  startLine: number;
  endLine: number;
}

interface NotebookAnnotationComposerProps {
  selectedRange: LineRange | null;
  onCreateAnnotation: ((annotation: CodeAnnotationDraft) => void) | undefined;
  selectedFlatText: string;
  setSelectedRange: Dispatch<SetStateAction<LineRange | null>>;
}

export function NotebookAnnotationComposer({
  selectedRange,
  onCreateAnnotation,
  selectedFlatText,
  setSelectedRange,
}: NotebookAnnotationComposerProps) {
  if (!selectedRange || !onCreateAnnotation) return null;

  return (
    <div className="sticky bottom-3 mx-auto mt-3">
      <AnnotationComposerPanel
        targetLabel={formatAnnotationTargetLabel(selectedRange)}
        onCancel={() => setSelectedRange(null)}
        onSubmit={({ intent, comment }) => {
          onCreateAnnotation({
            intent,
            comment,
            startLine: selectedRange.startLine,
            endLine: selectedRange.endLine,
            text: selectedFlatText,
          });
          setSelectedRange(null);
        }}
      />
    </div>
  );
}
