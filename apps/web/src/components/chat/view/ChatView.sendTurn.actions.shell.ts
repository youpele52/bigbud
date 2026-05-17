import { readNativeApi } from "../../../rpc/nativeApi";
import type { useRemoteExecutionAccessGate } from "../../../hooks/useRemoteExecutionAccessGate";
import { newCommandId, newMessageId } from "~/lib/utils";

import {
  buildThreadBootstrap,
  restoreShellComposerDraftAfterFailure,
} from "./ChatView.sendTurn.helpers";
import {
  isCurrentComposerDraftEmpty,
  persistThreadSettingsForNextTurnIfServer,
  prepareSendContext,
} from "./ChatView.sendTurn.actions.shared";
import type { UseOnSendInput } from "./ChatView.sendTurn.types";

interface SendTurnActionInput {
  api: NonNullable<ReturnType<typeof readNativeApi>>;
  input: UseOnSendInput;
  onSend: () => Promise<void>;
  resetComposerDraft: () => void;
  ensureRemoteExecutionTargetAccess: ReturnType<
    typeof useRemoteExecutionAccessGate
  >["ensureRemoteExecutionTargetAccess"];
}

export async function sendShellCommand({
  api,
  input,
  onSend,
  resetComposerDraft,
  ensureRemoteExecutionTargetAccess,
}: SendTurnActionInput) {
  const {
    activeProject: project,
    activeThread: thread,
    isServerThread: isServer,
    isLocalDraftThread: isDraft,
    promptRef,
    composerImages,
    composerImagesRef,
    composerFiles,
    composerFilesRef,
    composerAnnotations,
    composerAnnotationsRef,
    composerTerminalContexts,
    composerTerminalContextsRef,
    selectedModelSelection,
    runtimeMode,
    interactionMode,
    shouldAutoScrollRef,
  } = input;
  if (!thread) return;

  if (
    composerImages.length > 0 ||
    composerFiles.length > 0 ||
    composerAnnotations.length > 0 ||
    composerTerminalContexts.length > 0
  ) {
    input.setThreadError(thread.id, "Shell commands can't include attachments or inline context.");
    return;
  }

  const shellPromptForSend = promptRef.current;
  const shellCommand = shellPromptForSend.trimStart();
  if (!shellCommand) {
    input.setThreadError(thread.id, "Enter a shell command.");
    return;
  }
  if (!project) return;

  const sendContext = await prepareSendContext({
    input,
    onSend,
    ensureRemoteExecutionTargetAccess,
  });
  if (!sendContext) {
    return;
  }
  const { threadIdForSend, isFirstMessage, baseBranchForWorktree } = sendContext;

  const messageIdForSend = newMessageId();
  const messageCreatedAt = new Date().toISOString();
  input.sendInFlightRef.current = true;
  input.beginLocalDispatch({ preparingWorktree: Boolean(baseBranchForWorktree) });
  input.setThreadError(threadIdForSend, null);
  shouldAutoScrollRef.current = true;
  input.forceStickToBottom();
  resetComposerDraft();

  let shellRunSucceeded = false;
  await (async () => {
    await persistThreadSettingsForNextTurnIfServer({
      isServer,
      persistThreadSettingsForNextTurn: input.persistThreadSettingsForNextTurn,
      params: {
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        modelSelection: selectedModelSelection,
        runtimeMode,
        interactionMode,
      },
    });

    const bootstrap = buildThreadBootstrap({
      thread,
      project,
      isDraft,
      isFirstMessage,
      promptText: shellCommand,
      modelSelection: selectedModelSelection,
      runtimeMode,
      interactionMode,
      baseBranchForWorktree,
    });
    input.beginLocalDispatch({ preparingWorktree: false });
    await api.orchestration.dispatchCommand({
      type: "thread.shell.run",
      commandId: newCommandId(),
      threadId: threadIdForSend,
      message: {
        messageId: messageIdForSend,
        role: "user",
        text: shellCommand,
        attachments: [],
      },
      shellCommand,
      ...(bootstrap ? { bootstrap } : {}),
      createdAt: messageCreatedAt,
    });
    shellRunSucceeded = true;
  })().catch((err: unknown) => {
    restoreShellComposerDraftAfterFailure({
      currentDraftEmpty:
        !shellRunSucceeded &&
        isCurrentComposerDraftEmpty({
          promptRef,
          composerImagesRef,
          composerFilesRef,
          composerAnnotationsRef,
          composerTerminalContextsRef,
        }),
      messageIdForSend,
      promptText: shellPromptForSend,
      promptRef,
      setOptimisticUserMessages: input.setOptimisticUserMessages,
      setPrompt: input.setPrompt,
      setComposerShellMode: input.setComposerShellMode,
      setComposerCursor: (next) => {
        input.setComposerCursor(next);
      },
      setComposerTrigger: (trigger) => {
        input.setComposerTrigger(trigger);
      },
    });
    input.setThreadError(
      threadIdForSend,
      err instanceof Error ? err.message : "Failed to run shell command.",
    );
  });
  input.sendInFlightRef.current = false;
  input.resetLocalDispatch();
}
