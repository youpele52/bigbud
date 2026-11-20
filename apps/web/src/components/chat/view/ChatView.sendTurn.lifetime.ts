import { useComposerDraftStore } from "../../../stores/composer";
import type { UseOnSendInput } from "./ChatView.sendTurn.types";

/** UI refs belong to a mounted thread, while draft setters already capture the original ID. */
export function ownSendInput(input: UseOnSendInput, isCurrent: () => boolean): UseOnSendInput {
  const threadId = input.activeThread!.id;
  const draft = () => useComposerDraftStore.getState().draftsByThreadId[threadId];
  const ref = <T>(source: { current: T }, detached: () => T) => ({
    get current() {
      return isCurrent() ? source.current : detached();
    },
    set current(value: T) {
      if (isCurrent()) source.current = value;
    },
  });
  const ui =
    <T extends unknown[]>(callback: (...args: T) => void) =>
    (...args: T) => {
      if (isCurrent()) callback(...args);
    };
  return {
    ...input,
    promptRef: ref(input.promptRef, () => draft()?.prompt ?? ""),
    composerImagesRef: ref(input.composerImagesRef, () => draft()?.images ?? []),
    composerFilesRef: ref(input.composerFilesRef, () => draft()?.files ?? []),
    composerAnnotationsRef: ref(input.composerAnnotationsRef, () => draft()?.annotations ?? []),
    composerTerminalContextsRef: ref(
      input.composerTerminalContextsRef,
      () => draft()?.terminalContexts ?? [],
    ),
    sendInFlightRef: ref(input.sendInFlightRef, () => false),
    shouldAutoScrollRef: ref(input.shouldAutoScrollRef, () => false),
    beginLocalDispatch: ui(input.beginLocalDispatch),
    resetLocalDispatch: ui(input.resetLocalDispatch),
    setOptimisticUserMessages: ui(input.setOptimisticUserMessages),
    setComposerCursor: ui(input.setComposerCursor),
    setComposerTrigger: ui(input.setComposerTrigger),
    setComposerHighlightedItemId: ui(input.setComposerHighlightedItemId),
    forceStickToBottom: ui(input.forceStickToBottom),
    scrollToUserTurnAnchor: ui(input.scrollToUserTurnAnchor),
    onOptimisticUserMessage: input.onOptimisticUserMessage
      ? ui(input.onOptimisticUserMessage)
      : undefined,
  };
}
