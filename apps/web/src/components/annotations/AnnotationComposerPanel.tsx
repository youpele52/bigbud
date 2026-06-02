import type { AnnotationIntent } from "../../stores/composer";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { cn } from "~/lib/utils";
import { useState } from "react";

interface AnnotationComposerPanelProps {
  title: string;
  targetLabel: string;
  submitLabel?: string;
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
  fix: "What should change here?",
};

export function AnnotationComposerPanel({
  title,
  targetLabel,
  submitLabel = "Add to chat",
  onCancel,
  onSubmit,
}: AnnotationComposerPanelProps) {
  const [intent, setIntent] = useState<AnnotationIntent>("fix");
  const [comment, setComment] = useState("");

  return (
    <div className="rounded-lg border border-border bg-card p-2 shadow-lg">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-foreground">{title}</p>
          <p className="truncate text-[11px] text-muted-foreground/70" title={targetLabel}>
            {targetLabel}
          </p>
        </div>
        <div className="flex shrink-0 rounded-md bg-muted/45 p-0.5">
          {INTENT_OPTIONS.map((option) => (
            <button
              key={option.intent}
              type="button"
              className={cn(
                "rounded px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground",
                intent === option.intent && "bg-background text-foreground shadow-xs",
              )}
              onClick={() => setIntent(option.intent)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <Textarea
        size="sm"
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder={PLACEHOLDER_BY_INTENT[intent]}
        className="mb-2"
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => onSubmit({ intent, comment: comment.trim() })}
        >
          {intent === "fix" ? "Request change" : submitLabel}
        </Button>
      </div>
    </div>
  );
}
