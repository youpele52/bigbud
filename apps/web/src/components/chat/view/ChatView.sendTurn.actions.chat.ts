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
} from "./ChatView.sendTurn.helpers";
import {
  persistThreadSettingsForNextTurnIfServer,
  prepareSendContext,
} from "./ChatView.sendTurn.actions.shared";
import { formatReadDocumentPrompt, parseReadDocumentCommand } from "./ChatView.sendTurn.read";
import type { UseOnSendInput } from "./ChatView.sendTurn.types";
import { digestMaterializationRequest } from "../../../stores/materialization/materializationRequestDigest";
import {
  completeMaterialization,
  markMaterializationDispatching,
  prepareMaterializationForSend,
} from "./ChatView.sendTurn.materialization";
import { handleChatSendFailure } from "./ChatView.sendTurn.chat.failure";

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
    composerFiles,
    composerAnnotations,
    composerTerminalContexts,
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

  const readDocumentCommand = parseReadDocumentCommand(trimmedPrompt);

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

  const promptTextForSend = readDocumentCommand
    ? await api.server
        .readDocumentUrl({ url: readDocumentCommand.url })
        .then(formatReadDocumentPrompt)
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not read document URL",
            description: error instanceof Error ? error.message : "Check the URL and try again.",
          });
          return null;
        })
    : promptForSend;
  if (!promptTextForSend) {
    return;
  }
  const transformedPromptTextForSend = input.transformPromptForSend
    ? input.transformPromptForSend(promptTextForSend)
    : promptTextForSend;

  const sendContext = await prepareSendContext({
    input,
    onSend,
    ensureRemoteExecutionTargetAccess,
  });
  if (!sendContext) {
    return;
  }
  const { threadIdForSend, isFirstMessage, baseBranchForWorktree } = sendContext;

  const composerImagesSnapshot = [...composerImages];
  const composerFilesSnapshot = [...composerFiles];
  const composerAnnotationsSnapshot = [...composerAnnotations];
  const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
  const messageTextWithTerminalContexts = appendTerminalContextsToPrompt(
    transformedPromptTextForSend,
    composerTerminalContextsSnapshot,
  );
  const messageTextForSend = appendBrowserAnnotationsToPrompt(
    messageTextWithTerminalContexts,
    composerAnnotationsSnapshot,
  );
  let messageIdForSend = newMessageId();
  let commandIdForSend = newCommandId();
  const messageCreatedAt = new Date().toISOString();
  const outgoingMessageText = formatOutgoingPrompt({
    provider: selectedProvider,
    model: selectedModel,
    models: selectedProviderModels,
    effort: selectedPromptEffort,
    text: messageTextForSend || IMAGE_ONLY_BOOTSTRAP_PROMPT,
  });
  const requestDigest = await digestMaterializationRequest({
    kind: "turn",
    threadId: threadIdForSend,
    projectId: project.id,
    message: {
      role: "user",
      text: outgoingMessageText,
      replyToMessageId: replyTarget?.messageId ?? null,
      attachments: [
        ...composerImagesSnapshot.map(({ id, name, mimeType, sizeBytes }) => ({
          id,
          name,
          mimeType,
          sizeBytes,
        })),
        ...composerFilesSnapshot.map(({ id, name, sizeBytes }) => ({ id, name, sizeBytes })),
      ],
    },
    modelSelection: selectedModelSelection,
    runtimeMode,
    interactionMode,
    bootstrap: { isFirstMessage, baseBranchForWorktree, bootstrapSourceThreadId },
  });
  const materializationGate = await prepareMaterializationForSend({
    api,
    isDraft,
    threadId: threadIdForSend,
    projectId: project.id,
    commandId: commandIdForSend,
    messageId: messageIdForSend,
    kind: "turn",
    createdAt: messageCreatedAt,
    requestDigest,
    setThreadError: input.setThreadError,
    onThreadMaterialized: input.onThreadMaterialized,
  });
  if (!materializationGate.proceed) return;
  const materializationAttempt = materializationGate.attempt;
  if (materializationAttempt) {
    messageIdForSend = materializationAttempt.messageId;
    commandIdForSend = materializationAttempt.commandId;
  }

  input.sendInFlightRef.current = true;
  input.beginLocalDispatch({ preparingWorktree: Boolean(baseBranchForWorktree) });
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
  input.onOptimisticUserMessage?.(messageIdForSend);
  shouldAutoScrollRef.current = true;
  input.scrollToUserTurnAnchor(messageIdForSend);

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
        ? draftTitleFromMessage(transformedPromptTextForSend)
        : undefined;
    const bootstrap = buildThreadBootstrap({
      thread,
      project,
      isDraft,
      isFirstMessage,
      promptText: transformedPromptTextForSend,
      modelSelection: selectedModelSelection,
      runtimeMode,
      interactionMode,
      baseBranchForWorktree,
      recoveryCommandId: commandIdForSend,
    });
    input.beginLocalDispatch({ preparingWorktree: false });
    await markMaterializationDispatching(materializationAttempt);
    const dispatchResult = await api.orchestration.dispatchCommand({
      type: "thread.turn.start",
      commandId: commandIdForSend,
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
    await completeMaterialization(
      { threadId: threadIdForSend, onThreadMaterialized: input.onThreadMaterialized },
      materializationAttempt,
      dispatchResult.sequence,
    );
    recordModelUsage(
      selectedModelSelection.provider,
      selectedModelSelection.model,
      "subProviderID" in selectedModelSelection ? selectedModelSelection.subProviderID : undefined,
    );
  })().catch(async (err: unknown) => {
    turnStartSucceeded = await handleChatSendFailure({
      api,
      sendInput: input,
      error: err,
      materializationAttempt,
      turnStartSucceeded,
      threadId: threadIdForSend,
      messageId: messageIdForSend,
      promptText: promptForSend,
      images: composerImagesSnapshot,
      files: composerFilesSnapshot,
      annotations: composerAnnotationsSnapshot,
      terminalContexts: composerTerminalContextsSnapshot,
    });
  });
  input.sendInFlightRef.current = false;
  if (!turnStartSucceeded) {
    input.resetLocalDispatch();
  }
}
