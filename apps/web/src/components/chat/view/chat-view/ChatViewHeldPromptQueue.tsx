import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Button } from "~/components/ui/button";
import { ComposerPromptQueue } from "../../composer/ComposerPromptQueue";
import { useHeldDraft } from "../ChatView.heldDraft.hooks";
import type { ChatViewInteractionsState } from "./chat-view-interactions.hooks";

export function ChatViewHeldPromptQueue({
  threadId,
  queue,
  canControl,
  activeTurn,
}: {
  threadId: string;
  queue: ChatViewInteractionsState["promptQueue"];
  canControl: boolean;
  activeTurn: boolean;
}) {
  const recovery = useHeldDraft(ThreadId.makeUnsafe(threadId));
  const { draft, error, busy } = recovery;
  return (
    <>
      <ComposerPromptQueue
        queuedPrompts={queue.queuedPrompts}
        queueHold={queue.queueHold}
        canSendNow={canControl}
        canRecover={recovery.canRecover}
        onRecoverPrompt={(id) => {
          const prompt = queue.queuedPrompts.find((item) => item.id === id);
          if (prompt) recovery.recover(prompt);
        }}
        onRemovePrompt={queue.removeQueuedPrompt}
        onInterruptAndFlush={() => {
          void queue.interruptAndFlushQueuedPrompts();
        }}
        canSteer={canControl && activeTurn && queue.canSteer}
        controlOperation={queue.controlOperation}
        onSteer={() => {
          void queue.steerQueuedPrompts();
        }}
      />
      {draft ? (
        <section
          aria-label="Recovered message draft"
          className="space-y-2 border-b border-border/65 px-3 py-2 sm:px-4"
        >
          <p className="text-sm font-medium">
            {draft.claimed ? "Recovered message draft" : "Recovering held message"}
          </p>
          {draft.claimed ? (
            <>
              {draft.prompt.replyTo ? (
                <p className="text-xs text-muted-foreground">
                  Reply to: {draft.prompt.replyTo.excerpt}
                </p>
              ) : null}
              <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm">
                {draft.prompt.text}
              </p>
              {draft.prompt.attachments?.length ? (
                <ul aria-label="Recovered attachments" className="text-xs text-muted-foreground">
                  {draft.prompt.attachments.map((attachment) => (
                    <li key={attachment.id}>{attachment.name}</li>
                  ))}
                </ul>
              ) : null}
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || !canControl || draft.recovery?.action === "discard"}
                  onClick={() => recovery.settle("send")}
                >
                  {draft.recovery?.action === "send" ? "Retry Send" : "Send recovered message"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy || draft.recovery?.action === "send"}
                  onClick={() => recovery.settle("discard")}
                >
                  {draft.recovery?.action === "discard"
                    ? "Retry discard"
                    : "Discard recovered draft"}
                </Button>
              </div>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={recovery.retryClaim}
            >
              Retry recovery
            </Button>
          )}
        </section>
      ) : null}
      {error ? (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}
