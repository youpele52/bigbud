import { readNativeApi } from "../../../rpc/nativeApi";
import { recordModelUsage } from "../../../models/recentlyUsedModels";
import type { ChatAttachment } from "../../../models/types";
import type { useRemoteExecutionAccessGate } from "../../../hooks/useRemoteExecutionAccessGate";
import { newCommandId, newMessageId } from "~/lib/utils";

import { DEFAULT_THREAD_TITLE, draftTitleFromMessage } from "./ChatView.threadTitle.logic";
import {
  buildOptimisticAttachments,
  buildThreadBootstrap,
  buildTurnAttachments,
} from "./ChatView.sendTurn.helpers";
import {
  persistThreadSettingsForNextTurnIfServer,
  prepareSendContext,
} from "./ChatView.sendTurn.actions.shared";
import { notifyOmittedTerminalContexts, prepareComposerPrompt } from "./ChatView.sendTurn.prepare";
import type { UseOnSendInput } from "./ChatView.sendTurn.types";
import { digestMaterializationRequest } from "../../../stores/materialization/materializationRequestDigest";
import {
  completeMaterialization,
  markMaterializationDispatching,
  prepareMaterializationForSend,
} from "./ChatView.sendTurn.materialization";
import { handleChatSendFailure } from "./ChatView.sendTurn.chat.failure";
import { preservePendingEnvMode } from "../../../lib/threadMaterialization.envMode";

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
    selectedModel,
    selectedModelSelection,
    runtimeMode,
    interactionMode,
    bootstrapSourceThreadId,
    replyTarget,
    shouldAutoScrollRef,
  } = input;
  if (!thread) return;
  const prepared = await prepareComposerPrompt({ api, sendInput: input, resetComposerDraft });
  if (!prepared || !project) return;
  const {
    promptText: promptForSend,
    transformedPromptText: transformedPromptTextForSend,
    outgoingMessageText,
    images: composerImagesSnapshot,
    files: composerFilesSnapshot,
    annotations: composerAnnotationsSnapshot,
    terminalContexts: composerTerminalContextsSnapshot,
    expiredTerminalContextCount,
  } = prepared;

  const sendContext = await prepareSendContext({
    input,
    onSend,
    ensureRemoteExecutionTargetAccess,
  });
  if (!sendContext) {
    return;
  }
  const { threadIdForSend, isFirstMessage, baseBranchForWorktree, creationAdmission } = sendContext;
  const isDraft = creationAdmission.requiresCreate;
  const isServer = !isDraft;
  let turnStartSucceeded = false;
  try {
    let messageIdForSend = newMessageId();
    let commandIdForSend = newCommandId();
    const messageCreatedAt = new Date().toISOString();
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
    notifyOmittedTerminalContexts(expiredTerminalContextCount);
    resetComposerDraft();

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
      if (isFirstMessage) preservePendingEnvMode(threadIdForSend, "local");
      await completeMaterialization(
        { threadId: threadIdForSend, onThreadMaterialized: input.onThreadMaterialized },
        materializationAttempt,
        dispatchResult.sequence,
      );
      recordModelUsage(
        selectedModelSelection.provider,
        selectedModelSelection.model,
        "subProviderID" in selectedModelSelection
          ? selectedModelSelection.subProviderID
          : undefined,
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
  } finally {
    creationAdmission.settle(turnStartSucceeded);
    input.sendInFlightRef.current = false;
    if (!turnStartSucceeded) input.resetLocalDispatch();
  }
}
