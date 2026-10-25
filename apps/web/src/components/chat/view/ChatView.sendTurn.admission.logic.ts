import { Equal } from "effect";

import type { QueuedPromptSubmission } from "./ChatView.promptQueue.logic";
import type { UseOnSendInput } from "./ChatView.sendTurn.types";

type ComposerQueueInput = Pick<
  UseOnSendInput,
  | "activeThread"
  | "isServerThread"
  | "isLocalDraftThread"
  | "bootstrapSourceThreadId"
  | "isComposerShellMode"
> & {
  readonly shouldQueuePrompt: boolean;
  readonly planFollowUp: boolean;
};

/**
 * While a turn runs, every composer send on an existing server thread is queued with its full
 * content (attachments, reply target, and changed settings). Plan follow-ups, bootstrap sends,
 * and shell commands keep their own paths.
 */
export function canQueueComposerPrompt(input: ComposerQueueInput): boolean {
  const thread = input.activeThread;
  return Boolean(
    input.shouldQueuePrompt &&
    thread &&
    input.isServerThread &&
    !input.isLocalDraftThread &&
    thread.messages.length > 0 &&
    !input.planFollowUp &&
    input.bootstrapSourceThreadId === null &&
    !input.isComposerShellMode,
  );
}

/**
 * Explicit settings travel with a queued prompt only when they differ from the thread's, so a
 * plain follow-up stays eligible for native steering and combines with its neighbours.
 */
export function changedQueuedPromptSettings(
  input: Pick<UseOnSendInput, "selectedModelSelection" | "runtimeMode" | "interactionMode">,
  thread: NonNullable<UseOnSendInput["activeThread"]>,
): Pick<QueuedPromptSubmission, "modelSelection" | "runtimeMode" | "interactionMode"> {
  return {
    ...(!Equal.equals(input.selectedModelSelection, thread.modelSelection)
      ? { modelSelection: input.selectedModelSelection }
      : {}),
    ...(input.runtimeMode !== thread.runtimeMode ? { runtimeMode: input.runtimeMode } : {}),
    ...(input.interactionMode !== thread.interactionMode
      ? { interactionMode: input.interactionMode }
      : {}),
  };
}
