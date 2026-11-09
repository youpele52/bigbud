import { useChatViewPromptQueue } from "./chat-view/chat-view-prompt-queue.hooks";
import { useSendHarnessInput } from "./ChatView.sendTurn.browser-helpers";

type QueueInput = Parameters<typeof useChatViewPromptQueue>[0];

/** Real queue binding and send hook; only unrelated view/render state is omitted. */
export function QueueSendHarness(props: Parameters<typeof useSendHarnessInput>[0]) {
  const input = useSendHarnessInput({
    ...props,
    overrides: { isSendBusy: true, ...props.overrides },
  });
  const { onSend } = useChatViewPromptQueue({
    base: {
      ...input,
      threadId: props.threadId,
      isRevertingCheckpoint: false,
      composerDraft: {
        shellMode: input.isComposerShellMode,
        bootstrapSourceThreadId: input.bootstrapSourceThreadId,
        replyTarget: input.replyTarget,
      },
      randomUUID: () => crypto.randomUUID(),
      setBootstrapSourceThreadId: input.clearBootstrapSourceThreadId,
      setComposerReplyTarget: input.setReplyTarget,
    } as unknown as QueueInput["base"],
    composer: {
      ...input,
      activeProviderStatus: undefined,
    } as unknown as QueueInput["composer"],
    thread: {
      ...input,
      activeSessionTurnRunning: true,
      latestTurnSettled: false,
    } as unknown as QueueInput["thread"],
    runtime: {
      scrollBehavior: {
        shouldAutoScrollRef: input.shouldAutoScrollRef,
        forceStickToBottom: input.forceStickToBottom,
        scrollToUserTurnAnchor: input.scrollToUserTurnAnchor,
      },
      setThreadError: input.setThreadError,
      persistThreadSettingsForNextTurn: input.persistThreadSettingsForNextTurn,
      handleInteractionModeChange: input.handleInteractionModeChange,
      turnActions: { onRespondToUserInput: input.onRespondToUserInput },
    } as unknown as QueueInput["runtime"],
    envMode: "local",
    planHandlers: { onSubmitPlanFollowUp: input.onSubmitPlanFollowUp },
    transformPromptForSend: input.transformPromptForSend,
  });
  props.control.onSend = onSend;
  return <button onClick={() => void onSend()}>Send {props.threadId}</button>;
}
