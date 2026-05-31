import { XIcon } from "lucide-react";

import { Button } from "../../ui/button";
import type { QueuedPrompt } from "../view/ChatView.promptQueue.logic";
import { MAX_QUEUED_PROMPTS } from "../view/ChatView.promptQueue.logic";

interface ComposerPromptQueueProps {
  queuedPrompts: readonly QueuedPrompt[];
  canSendNow: boolean;
  onRemovePrompt: (id: string) => void;
  onInterruptAndFlush: () => void;
}

export function ComposerPromptQueue({
  queuedPrompts,
  canSendNow,
  onRemovePrompt,
  onInterruptAndFlush,
}: ComposerPromptQueueProps) {
  if (queuedPrompts.length === 0) {
    return null;
  }

  return (
    <div className="border-b border-border/65 px-3 py-2 sm:px-4">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">
          Queued {queuedPrompts.length}/{MAX_QUEUED_PROMPTS}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 rounded-full px-2.5 text-xs"
          disabled={!canSendNow}
          onClick={onInterruptAndFlush}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Send now
        </Button>
      </div>
      <div className="mt-2 flex max-h-24 flex-col gap-1 overflow-y-auto">
        {queuedPrompts.map((prompt, index) => (
          <div key={prompt.id} className="flex min-w-0 items-start gap-2 text-xs">
            <span className="mt-1 shrink-0 text-muted-foreground">{index + 1}.</span>
            <span className="min-w-0 flex-1 truncate text-foreground/85">{prompt.text}</span>
            <button
              type="button"
              className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => onRemovePrompt(prompt.id)}
              aria-label={`Remove queued prompt ${index + 1}`}
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
