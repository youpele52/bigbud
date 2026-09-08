import { XIcon } from "lucide-react";
import type { MessageId, OrchestrationTurnControlOperation } from "@bigbud/contracts";

import { Button } from "../../ui/button";
import type { QueuedPrompt } from "../view/ChatView.promptQueue.logic";
import { MAX_QUEUED_PROMPTS } from "../view/ChatView.promptQueue.logic";

interface ComposerPromptQueueProps {
  queuedPrompts: readonly QueuedPrompt[];
  canSendNow: boolean;
  onRemovePrompt: (id: string) => void;
  onInterruptAndFlush: () => void;
  canSteer: boolean;
  onSteer: () => void;
  nativeSteer: boolean;
  controlOperation: OrchestrationTurnControlOperation | null;
}

export function ComposerPromptQueue({
  queuedPrompts,
  canSendNow,
  onRemovePrompt,
  onInterruptAndFlush,
  canSteer,
  onSteer,
  nativeSteer,
  controlOperation,
}: ComposerPromptQueueProps) {
  if (queuedPrompts.length === 0) {
    return null;
  }
  const controlPending =
    controlOperation !== null &&
    !["completed", "failed", "superseded", "cancelled"].includes(controlOperation.state);

  return (
    <div className="border-b border-border/65 px-3 py-2 sm:px-4">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">
          {controlOperation
            ? controlOperation.state === "ambiguous"
              ? "Steer delivery uncertain · prompts held"
              : controlOperation.strategy === "interrupt-continue"
                ? "Interrupting before continuation"
                : `Turn control: ${controlOperation.state}`
            : `Queued ${queuedPrompts.length}/${MAX_QUEUED_PROMPTS}`}
        </span>
        <div className="flex items-center gap-1.5">
          {canSteer ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 rounded-full px-2.5 text-xs"
              onClick={onSteer}
              disabled={controlPending}
              title={
                nativeSteer
                  ? undefined
                  : "This provider stops the current response before applying queued instructions."
              }
            >
              Steer
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 rounded-full px-2.5 text-xs"
            disabled={!canSendNow || controlPending}
            onClick={onInterruptAndFlush}
          >
            Stop &amp; send
          </Button>
        </div>
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
              disabled={
                controlPending &&
                controlOperation?.reservedPromptIds.includes(prompt.id as MessageId) === true
              }
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
