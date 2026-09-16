import { Equal } from "effect";

import type { UseOnSendInput } from "./ChatView.sendTurn.types";

type OptimisticQueueInput = Pick<
  UseOnSendInput,
  | "activeThread"
  | "isLocalDraftThread"
  | "bootstrapSourceThreadId"
  | "replyTarget"
  | "composerImages"
  | "composerFiles"
  | "composerAnnotations"
  | "composerTerminalContexts"
  | "selectedModelSelection"
  | "runtimeMode"
  | "interactionMode"
> & {
  readonly shouldQueuePrompt: boolean;
  readonly planFollowUp: boolean;
};

export function canOptimisticallyQueuePrompt(input: OptimisticQueueInput): boolean {
  const thread = input.activeThread;
  if (
    !input.shouldQueuePrompt ||
    !thread ||
    input.isLocalDraftThread ||
    thread.messages.length === 0 ||
    input.planFollowUp ||
    input.bootstrapSourceThreadId !== null ||
    input.replyTarget !== null ||
    input.composerImages.length > 0 ||
    input.composerFiles.length > 0 ||
    input.composerAnnotations.length > 0 ||
    input.composerTerminalContexts.length > 0
  ) {
    return false;
  }

  return (
    Equal.equals(input.selectedModelSelection, thread.modelSelection) &&
    input.runtimeMode === thread.runtimeMode &&
    input.interactionMode === thread.interactionMode
  );
}
