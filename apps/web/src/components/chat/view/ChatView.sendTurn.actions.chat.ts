import { parseStandaloneComposerSlashCommand } from "../../../logic/composer";
import { appendTerminalContextsToPrompt } from "../../../lib/terminalContext";
import { readNativeApi } from "../../../rpc/nativeApi";
import { recordModelUsage } from "../../../models/recentlyUsedModels";
import type { ChatAttachment } from "../../../models/types";
import type { useRemoteExecutionAccessGate } from "../../../hooks/useRemoteExecutionAccessGate";
import { newCommandId, newMessageId } from "~/lib/utils";
import { toastManager } from "../../ui/toast";

import {
  appendBrowserAnnotationsToPrompt,
  buildExpiredTerminalContextToastCopy,
  deriveComposerSendState,
  formatOutgoingPrompt,
} from "./ChatView.logic";
import { DEFAULT_THREAD_TITLE, draftTitleFromMessage } from "./ChatView.threadTitle.logic";
import {
  buildOptimisticAttachments,
  buildThreadBootstrap,
  buildTurnAttachments,
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
  restoreMessageComposerDraftAfterFailure,
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

export async function sendChatTurn({
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
    selectedProvider,
    selectedModel,
    selectedProviderModels,
    selectedPromptEffort,
    selectedModelSelection,
    runtimeMode,
    interactionMode,
    bootstrapSourceThreadId,
    replyTarget,
    shouldAutoScrollRef,
  } = input;
  if (!thread) return;

  const promptForSend = promptRef.current;
  const {
    trimmedPrompt,
    sendableTerminalContexts: sendableComposerTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent,
  } = deriveComposerSendState({
    prompt: promptForSend,
    imageCount: composerImages.length,
    fileCount: composerFiles.length,
    annotationCount: composerAnnotations.length,
    terminalContexts: composerTerminalContexts,
  });

  const standaloneSlashCommand =
    composerImages.length === 0 &&
    composerFiles.length === 0 &&
    composerAnnotations.length === 0 &&
    sendableComposerTerminalContexts.length === 0
      ? parseStandaloneComposerSlashCommand(trimmedPrompt)
      : null;
  if (standaloneSlashCommand) {
    if (standaloneSlashCommand === "plan" || standaloneSlashCommand === "default") {
      input.handleInteractionModeChange(standaloneSlashCommand);
    }
    resetComposerDraft();
    return;
  }

  if (!hasSendableContent) {
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(expiredTerminalContextCount, "empty");
      toastManager.add({
        type: "warning",
        title: toastCopy.title,
        description: toastCopy.description,
      });
    }
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

  input.sendInFlightRef.current = true;
  input.beginLocalDispatch({ preparingWorktree: Boolean(baseBranchForWorktree) });

  const composerImagesSnapshot = [...composerImages];
  const composerFilesSnapshot = [...composerFiles];
  const composerAnnotationsSnapshot = [...composerAnnotations];
  const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
  const messageTextWithTerminalContexts = appendTerminalContextsToPrompt(
    promptForSend,
    composerTerminalContextsSnapshot,
  );
  const messageTextForSend = appendBrowserAnnotationsToPrompt(
    messageTextWithTerminalContexts,
    composerAnnotationsSnapshot,
  );
  const messageIdForSend = newMessageId();
  const messageCreatedAt = new Date().toISOString();
  const outgoingMessageText = formatOutgoingPrompt({
    provider: selectedProvider,
    model: selectedModel,
    models: selectedProviderModels,
    effort: selectedPromptEffort,
    text: messageTextForSend || IMAGE_ONLY_BOOTSTRAP_PROMPT,
  });
  const turnAttachmentsPromise = buildTurnAttachments(
    composerImagesSnapshot,
    composerFilesSnapshot,
  );
  const optimisticAttachments: ChatAttachment[] = buildOptimisticAttachments(
    composerImagesSnapshot,
    composerFilesSnapshot,
  );
  input.setOptimisticUserMessages((existing) => [
    ...existing,
    {
      id: messageIdForSend,
      role: "user" as const,
      text: outgoingMessageText,
      ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
      ...(replyTarget ? { replyTo: replyTarget } : {}),
      createdAt: messageCreatedAt,
      streaming: false,
    },
  ]);
  shouldAutoScrollRef.current = true;
  input.forceStickToBottom();

  input.setThreadError(threadIdForSend, null);
  if (expiredTerminalContextCount > 0) {
    const toastCopy = buildExpiredTerminalContextToastCopy(expiredTerminalContextCount, "omitted");
    toastManager.add({
      type: "warning",
      title: toastCopy.title,
      description: toastCopy.description,
    });
  }
  resetComposerDraft();

  let turnStartSucceeded = false;
  await (async () => {
    await persistThreadSettingsForNextTurnIfServer({
      isServer,
      persistThreadSettingsForNextTurn: input.persistThreadSettingsForNextTurn,
      params: {
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        ...(selectedModel ? { modelSelection: selectedModelSelection } : {}),
        runtimeMode,
        interactionMode,
      },
    });

    const turnAttachments = await turnAttachmentsPromise;
    const seededTitle =
      isFirstMessage && (isDraft || thread.title.trim() === DEFAULT_THREAD_TITLE)
        ? draftTitleFromMessage(promptForSend)
        : undefined;
    const bootstrap = buildThreadBootstrap({
      thread,
      project,
      isDraft,
      isFirstMessage,
      promptText: promptForSend,
      modelSelection: selectedModelSelection,
      runtimeMode,
      interactionMode,
      baseBranchForWorktree,
    });
    input.beginLocalDispatch({ preparingWorktree: false });
    await api.orchestration.dispatchCommand({
      type: "thread.turn.start",
      commandId: newCommandId(),
      threadId: threadIdForSend,
      message: {
        messageId: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        attachments: turnAttachments,
        ...(replyTarget ? { replyToMessageId: replyTarget.messageId } : {}),
      },
      modelSelection: selectedModelSelection,
      runtimeMode,
      interactionMode,
      ...(bootstrap ? { bootstrap } : {}),
      ...(bootstrapSourceThreadId ? { bootstrapSourceThreadId } : {}),
      ...(seededTitle ? { titleSeed: seededTitle } : {}),
      createdAt: messageCreatedAt,
    });
    if (bootstrapSourceThreadId) {
      input.clearBootstrapSourceThreadId(threadIdForSend);
    }
    turnStartSucceeded = true;
    recordModelUsage(
      selectedModelSelection.provider,
      selectedModelSelection.model,
      "subProviderID" in selectedModelSelection ? selectedModelSelection.subProviderID : undefined,
    );
  })().catch(async (err: unknown) => {
    const { revokeUserMessagePreviewUrls } = await import("./ChatView.logic");
    restoreMessageComposerDraftAfterFailure({
      currentDraftEmpty:
        !turnStartSucceeded &&
        isCurrentComposerDraftEmpty({
          promptRef,
          composerImagesRef,
          composerFilesRef,
          composerAnnotationsRef,
          composerTerminalContextsRef,
        }),
      messageIdForSend,
      promptText: promptForSend,
      promptRef,
      replyTarget,
      composerImages: composerImagesSnapshot,
      composerFiles: composerFilesSnapshot,
      composerAnnotations: composerAnnotationsSnapshot,
      composerTerminalContexts: composerTerminalContextsSnapshot,
      setOptimisticUserMessages: input.setOptimisticUserMessages,
      revokeUserMessagePreviewUrls,
      setPrompt: input.setPrompt,
      setComposerCursor: (next) => {
        input.setComposerCursor(next);
      },
      addComposerImagesToDraft: input.addComposerImagesToDraft,
      addComposerFilesToDraft: input.addComposerFilesToDraft,
      addComposerAnnotationsToDraft: input.addComposerAnnotationsToDraft,
      addComposerTerminalContextsToDraft: input.addComposerTerminalContextsToDraft,
      setReplyTarget: (nextReplyTarget) => {
        input.setReplyTarget(threadIdForSend, nextReplyTarget);
      },
      setComposerTrigger: (trigger) => {
        input.setComposerTrigger(trigger);
      },
    });
    input.setThreadError(
      threadIdForSend,
      err instanceof Error ? err.message : "Failed to send message.",
    );
    if (bootstrapSourceThreadId) {
      input.clearBootstrapSourceThreadId(threadIdForSend);
    }
  });
  input.sendInFlightRef.current = false;
  if (!turnStartSucceeded) {
    input.resetLocalDispatch();
  }
}
