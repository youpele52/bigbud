import type { Dispatch, SetStateAction } from "react";

import { AnnotationComposerPanel } from "../annotations/AnnotationComposerPanel";
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
    <div className="sticky bottom-3 mx-auto mt-3 w-[min(36rem,calc(100%-1.5rem))]">
      <AnnotationComposerPanel
        title="Code comment"
        targetLabel={
          selectedRange.startLine === selectedRange.endLine
            ? `Line ${selectedRange.startLine}`
            : `Lines ${selectedRange.startLine}-${selectedRange.endLine}`
        }
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
