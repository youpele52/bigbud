import { ComposerPrimaryActions } from "../composer/ComposerPrimaryActions";
import { useChatViewPromptQueue } from "./chat-view/chat-view-prompt-queue.hooks";
import { useSendHarnessInput } from "./ChatView.sendTurn.browser-helpers";

type QueueInput = Parameters<typeof useChatViewPromptQueue>[0];

/** Real queue binding and send hook; only unrelated view/render state is omitted. */
export function QueueSendHarness(props: Parameters<typeof useSendHarnessInput>[0]) {
  const input = useSendHarnessInput({
    ...props,
    overrides: { isSendBusy: true, ...props.overrides },
  });
  const { onSend, canQueueChat } = useChatViewPromptQueue({
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
    } as unknown as QueueInput["runtime"],
    envMode: "local",
    planHandlers: { onSubmitPlanFollowUp: input.onSubmitPlanFollowUp },
    transformPromptForSend: input.transformPromptForSend,
  });
  props.control.onSend = onSend;
  return (
    <form onSubmit={onSend}>
      <ComposerPrimaryActions
        compact={false}
        pendingAction={null}
        isRunning
        queueMessage={canQueueChat}
        showPlanFollowUpPrompt={false}
        promptHasText={Boolean(input.promptRef.current.trim())}
        isSendBusy={input.isSendBusy}
        isConnecting={input.isConnecting}
        isPreparingWorktree={false}
        hasSendableContent={Boolean(input.promptRef.current.trim())}
        onPreviousPendingQuestion={() => {}}
        onInterrupt={() => {}}
        onImplementPlanInNewThread={() => {}}
      />
    </form>
  );
}
