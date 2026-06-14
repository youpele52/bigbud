import type { AnnotationIntent } from "../../stores/composer";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import { useState } from "react";

interface AnnotationComposerPanelProps {
  targetLabel: string;
  onCancel: () => void;
  onSubmit: (input: { intent: AnnotationIntent; comment: string }) => void;
}

const INTENT_OPTIONS: ReadonlyArray<{ intent: AnnotationIntent; label: string }> = [
  { intent: "ask", label: "Ask" },
  { intent: "context", label: "Context" },
  { intent: "fix", label: "Fix" },
];

const PLACEHOLDER_BY_INTENT: Record<AnnotationIntent, string> = {
  ask: "Ask a question or give an instruction...",
  context: "Anything to add? (optional)",
  fix: "What should happen here?",
};

const TITLE_BY_INTENT: Record<AnnotationIntent, string> = {
  ask: "Ask about selection",
  context: "Add context",
  fix: "Annotate selection",
};

const SUBMIT_LABEL_BY_INTENT: Record<AnnotationIntent, string> = {
  ask: "Add to chat",
  context: "Add as context",
  fix: "Add task",
};

export function formatAnnotationTargetLabel(range: { startLine: number; endLine: number }): string {
  return range.startLine === range.endLine
    ? `Line ${range.startLine}`
    : `Lines ${range.startLine}-${range.endLine}`;
}

export function AnnotationComposerPanel({
  targetLabel,
  onCancel,
  onSubmit,
}: AnnotationComposerPanelProps) {
  const [intent, setIntent] = useState<AnnotationIntent>("fix");
  const [comment, setComment] = useState("");

  return (
    <div
      className="rounded-[20px] border border-border bg-card p-3.5 shadow-[0_18px_54px_rgba(0,0,0,0.24)]"
      style={{ width: "min(420px, calc(100vw - 32px))" }}
    >
      <div className="mb-2.5 flex gap-0.5" role="group" aria-label="Annotation intent">
        {INTENT_OPTIONS.map((option) => (
          <button
            key={option.intent}
            type="button"
            aria-pressed={intent === option.intent}
            className={cn(
              "h-7 w-16 cursor-pointer rounded-md border-0 bg-transparent text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              intent === option.intent && "bg-foreground/8 font-semibold text-foreground",
            )}
            onClick={() => setIntent(option.intent)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p id="annotation-composer-title" className="mb-2 text-sm font-medium text-foreground">
        {TITLE_BY_INTENT[intent]}
      </p>
      <p
        id="annotation-composer-target"
        className="mb-2.5 break-words text-xs leading-snug text-muted-foreground"
        title={targetLabel}
      >
        {targetLabel}
      </p>
      <textarea
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder={PLACEHOLDER_BY_INTENT[intent]}
        aria-labelledby="annotation-composer-title annotation-composer-target"
        className="field-sizing-content min-h-[120px] w-full rounded-2xl border border-border bg-card p-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/72 focus-visible:border-ring/45 focus-visible:ring-2 focus-visible:ring-ring"
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
          onClick={() => onSubmit({ intent, comment: comment.trim() })}
          className="h-9 rounded-[10px] px-3 text-sm"
        >
          {SUBMIT_LABEL_BY_INTENT[intent]}
        </Button>
      </div>
    </div>
  );
}
