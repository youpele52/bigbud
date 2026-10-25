import { ChevronDownIcon } from "lucide-react";
import type { AnnotationIntent } from "../../stores/composer";
import { Button } from "../ui/button";
import { useState } from "react";

interface AnnotationComposerPanelProps {
  targetLabel: string;
  selectionPreview?: string;
  fillContainer?: boolean;
  onCancel: () => void;
  onSubmit: (input: { intent: AnnotationIntent; comment: string }) => void;
}

const DEFAULT_INTENT: AnnotationIntent = "comment";
const COMMENT_TITLE = "Comment on selection";
const COMMENT_PLACEHOLDER = "Ask a question or request a change";
const COMMENT_SUBMIT_LABEL = "Add comment";

export function formatAnnotationTargetLabel(range: { startLine: number; endLine: number }): string {
  return range.startLine === range.endLine
    ? `Line ${range.startLine}`
    : `Lines ${range.startLine}-${range.endLine}`;
}

export function AnnotationComposerPanel({
  targetLabel,
  selectionPreview,
  fillContainer = false,
  onCancel,
  onSubmit,
}: AnnotationComposerPanelProps) {
  const [comment, setComment] = useState("");

  return (
    <div
      data-annotation-composer="true"
      className="rounded-[20px] border border-border bg-card p-3.5 shadow-[0_18px_54px_rgba(0,0,0,0.24)]"
      style={{ width: fillContainer ? "100%" : "min(420px, calc(100vw - 32px))" }}
    >
      <p id="annotation-composer-title" className="mb-2 text-sm font-medium text-foreground">
        {COMMENT_TITLE}
      </p>
      {selectionPreview ? (
        <details key={targetLabel + selectionPreview} className="group/selection mb-2.5">
          <summary
            id="annotation-composer-target"
            className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-xs leading-snug text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            title={targetLabel}
          >
            <span className="break-words">{targetLabel}</span>
            <ChevronDownIcon
              aria-hidden="true"
              className="size-3 shrink-0 transition-transform duration-150 group-open/selection:rotate-180"
            />
          </summary>
          <pre
            aria-label="Selected source lines"
            className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-2 text-xs text-muted-foreground"
          >
            {selectionPreview}
          </pre>
        </details>
      ) : (
        <p
          id="annotation-composer-target"
          className="mb-2.5 break-words text-xs leading-snug text-muted-foreground"
          title={targetLabel}
        >
          {targetLabel}
        </p>
      )}
      <textarea
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder={COMMENT_PLACEHOLDER}
        aria-labelledby="annotation-composer-title annotation-composer-target"
        className="field-sizing-content min-h-[120px] w-full rounded-2xl border border-border bg-card p-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/72 focus-visible:border-ring/45"
      />
      <div className="mt-3 flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          className="h-9 rounded-[10px] border-border bg-foreground/4 px-3 text-sm"
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => onSubmit({ intent: DEFAULT_INTENT, comment: comment.trim() })}
          className="h-9 rounded-[10px] px-3 text-sm"
        >
          {COMMENT_SUBMIT_LABEL}
        </Button>
      </div>
    </div>
  );
}
