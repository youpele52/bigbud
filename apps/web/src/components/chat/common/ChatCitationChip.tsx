import { QuoteIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { XIcon } from "lucide-react";

import { Button } from "../../ui/button";
import { useChatCitationActions, type ChatCitationTarget } from "./ChatCitation.context";

export function ChatCitationChip({
  citation,
  onRemove,
  removeLabel = "Remove citation",
}: {
  citation: ChatCitationTarget;
  onRemove?: (() => void) | undefined;
  removeLabel?: string;
}) {
  const actions = useChatCitationActions();
  const author = citation.source.role === "assistant" ? "AI" : "You";
  return (
    <div className="inline-flex max-w-full items-center gap-1 rounded-lg border border-border/80 bg-background px-1 py-1">
      <button
        type="button"
        className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-xs text-foreground/80 outline-hidden transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Go to citation from ${author}: ${citation.selection.text}`}
        title={`${author}: ${citation.selection.text}`}
        onClick={() => actions?.openCitation(citation)}
        disabled={!actions}
      >
        <HugeiconsIcon icon={QuoteIcon} size={14} className="size-3.5 shrink-0 text-info" />
        <span className="shrink-0 text-muted-foreground">{author}</span>
        <span className="max-w-72 truncate">{citation.selection.text}</span>
      </button>
      {onRemove ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={removeLabel}
          onClick={onRemove}
        >
          <XIcon />
        </Button>
      ) : null}
    </div>
  );
}
