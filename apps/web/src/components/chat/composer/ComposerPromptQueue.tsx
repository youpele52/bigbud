import { XIcon } from "lucide-react";
import type { MessageId, OrchestrationTurnControlOperation } from "@bigbud/contracts";

import { Button } from "../../ui/button";
import type { QueuedPrompt } from "../view/ChatView.promptQueue.logic";
import { MAX_QUEUED_PROMPTS } from "../view/ChatView.promptQueue.logic";

interface ComposerPromptQueueProps {
  queuedPrompts: readonly QueuedPrompt[];
  canSendNow: boolean;
  queueHold?: boolean;
  onRecoverPrompt?: (id: string) => void;
  canRecover?: boolean;
  onRemovePrompt: (id: string) => void;
  onInterruptAndFlush: () => void;
  /** True only where the provider steers natively; Steer never interrupts the turn. */
  canSteer: boolean;
  onSteer: () => void;
  controlOperation: OrchestrationTurnControlOperation | null;
}

export function ComposerPromptQueue({
  queuedPrompts,
  canSendNow,
  queueHold = false,
  onRecoverPrompt,
  canRecover = false,
  onRemovePrompt,
  onInterruptAndFlush,
  canSteer,
  onSteer,
  controlOperation,
}: ComposerPromptQueueProps) {
  if (queuedPrompts.length === 0) {
    return null;
  }
  const controlPending =
    controlOperation !== null &&
    !["completed", "failed", "superseded", "cancelled"].includes(controlOperation.state);

  const interactionHeld = queuedPrompts.some((prompt) => prompt.pendingInteractionGate);
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
            : `Queued ${queuedPrompts.filter((prompt) => !prompt.alreadySent).length}/${MAX_QUEUED_PROMPTS}`}
        </span>
        <div className="flex items-center gap-1.5">
          {canSteer && !interactionHeld ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 rounded-full px-2.5 text-xs"
              onClick={onSteer}
              disabled={controlPending}
            >
              Steer
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 rounded-full px-2.5 text-xs"
            disabled={!canSendNow || controlPending || interactionHeld}
            onClick={onInterruptAndFlush}
          >
            Stop &amp; send
          </Button>
        </div>
      </div>
      {interactionHeld ? (
        <p role="status" className="mt-1 text-xs text-muted-foreground">
          A message was held before delivery. Only a confirmed resolution in the original session
          can release an interaction hold automatically. Recover to draft or discard the held entry.
        </p>
      ) : null}
      <div className="mt-2 flex max-h-24 flex-col gap-1 overflow-y-auto">
        {queuedPrompts.map((prompt, index) => {
          const held = queueHold || !!prompt.pendingInteractionGate;
          const reserved =
            controlPending &&
            controlOperation?.reservedPromptIds.includes(prompt.id as MessageId) === true;
          return (
            <div key={prompt.id} className="flex min-w-0 items-start gap-2 text-xs">
              <span className="mt-1 shrink-0 text-muted-foreground">{index + 1}.</span>
              <span className="min-w-0 flex-1 truncate text-foreground/85">
                {held ? "Held: " : ""}
                {prompt.text}
              </span>
              {held && onRecoverPrompt ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 shrink-0 px-2"
                  disabled={!canRecover || reserved}
                  onClick={() => onRecoverPrompt(prompt.id)}
                  aria-label={`Recover queued prompt ${index + 1} to draft`}
                >
                  Recover to draft
                </Button>
              ) : null}
              <button
                type="button"
                className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={() => onRemovePrompt(prompt.id)}
                disabled={reserved}
                aria-label={`${held ? "Discard" : "Remove"} queued prompt ${index + 1}`}
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
