import {
  type ApprovalRequestId,
  type ModelSelection,
  type ProviderInteractionMode,
  type ProviderKind,
  type RuntimeMode,
  type ServerProvider,
  type ThreadId,
} from "@bigbud/contracts";
import { useCallback, useRef } from "react";
import type { PendingUserInput } from "../../../logic/session";
import {
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  parseStandaloneComposerSlashCommand,
} from "../../../logic/composer";
import { resolvePlanFollowUpSubmission } from "../../../logic/proposed-plan";
import { buildTemporaryWorktreeBranchName } from "@bigbud/shared/git";
import {
  deriveComposerSendState,
  buildExpiredTerminalContextToastCopy,
  formatOutgoingPrompt,
  appendBrowserAnnotationsToPrompt,
  readFileAsDataUrl,
  cloneComposerImageForRetry,
  draftTitleFromMessage,
} from "./ChatView.logic";
import { appendTerminalContextsToPrompt } from "../../../lib/terminalContext";
import { toastManager } from "../../ui/toast";
import { readNativeApi } from "../../../rpc/nativeApi";
import { newCommandId, newMessageId } from "~/lib/utils";
import {
  type ComposerImageAttachment,
  type ComposerFileAttachment,
  type ComposerAnnotationAttachment,
} from "../../../stores/composer";
import type { TerminalContextDraft } from "../../../lib/terminalContext";
import type {
  ChatAttachment,
  ChatMessage,
  Thread,
  Project,
  ProposedPlan,
} from "../../../models/types";
import { isElectron } from "~/config/env/env.config";
import { recordModelUsage } from "../../../models/recentlyUsedModels";

const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";

export interface UseOnSendInput {
  activeThread: Thread | undefined;
  activeProject: Project | undefined;
  activeThreadId: ThreadId | null;
  isServerThread: boolean;
  isLocalDraftThread: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  sendInFlightRef: React.MutableRefObject<boolean>;
  promptRef: React.MutableRefObject<string>;
  composerImages: ComposerImageAttachment[];
  composerImagesRef: React.MutableRefObject<ComposerImageAttachment[]>;
  composerFiles: ComposerFileAttachment[];
  composerFilesRef: React.MutableRefObject<ComposerFileAttachment[]>;
  composerAnnotations: ComposerAnnotationAttachment[];
  composerAnnotationsRef: React.MutableRefObject<ComposerAnnotationAttachment[]>;
  composerTerminalContexts: TerminalContextDraft[];
  composerTerminalContextsRef: React.MutableRefObject<TerminalContextDraft[]>;
  selectedProvider: ProviderKind;
  selectedModel: string;
  selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
  selectedPromptEffort: string | null;
  selectedModelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  envMode: string;
  showPlanFollowUpPrompt: boolean;
  activeProposedPlan: ProposedPlan | null;
  isOpencodePendingUserInputMode: boolean;
  activePendingUserInputRequestId: ApprovalRequestId | null;
  activePendingUserInput: PendingUserInput | null;
  shouldAutoScrollRef: React.MutableRefObject<boolean>;
  setOptimisticUserMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setPrompt: (prompt: string) => void;
  setComposerCursor: React.Dispatch<React.SetStateAction<number>>;
  setComposerTrigger: React.Dispatch<React.SetStateAction<ComposerTrigger | null>>;
  setComposerHighlightedItemId: React.Dispatch<React.SetStateAction<string | null>>;
  setThreadError: (targetThreadId: ThreadId | null, error: string | null) => void;
  setStoreThreadError: (threadId: ThreadId, error: string | null) => void;
  addComposerImagesToDraft: (images: ComposerImageAttachment[]) => void;
  addComposerFilesToDraft: (files: ComposerFileAttachment[]) => void;
  addComposerAnnotationsToDraft: (annotations: ComposerAnnotationAttachment[]) => void;
  addComposerTerminalContextsToDraft: (contexts: TerminalContextDraft[]) => void;
  clearComposerDraftContent: (threadId: ThreadId) => void;
  bootstrapSourceThreadId: ThreadId | null;
  clearBootstrapSourceThreadId: (threadId: ThreadId) => void;
  beginLocalDispatch: (opts: { preparingWorktree: boolean }) => void;
  resetLocalDispatch: () => void;
  forceStickToBottom: () => void;
  persistThreadSettingsForNextTurn: (input: {
    threadId: ThreadId;
    createdAt: string;
    modelSelection?: ModelSelection;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }) => Promise<void>;
  onSubmitPlanFollowUp: (input: {
    text: string;
    interactionMode: ProviderInteractionMode;
  }) => Promise<void>;
  handleInteractionModeChange: (mode: ProviderInteractionMode) => void;
  onRespondToUserInput: (
    requestId: ApprovalRequestId,
    answers: Record<string, unknown>,
  ) => Promise<void>;
}

/** Returns the `onSend` handler for the composer form. */
export function useOnSend(input: UseOnSendInput) {
  // Stable ref to avoid stale closure in the returned function
  const inputRef = useRef(input);
  inputRef.current = input;

  return useCallback(async (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    const api = readNativeApi();
    const {
      activeThread: thread,
      activeProject: project,
      isServerThread: isServer,
      isLocalDraftThread: isDraft,
      isSendBusy: sendBusy,
      isConnecting: connecting,
      sendInFlightRef: inFlightRef,
      promptRef: pRef,
      composerImages: images,
      composerImagesRef: imagesRef,
      composerFiles: files,
      composerFilesRef: filesRef,
      composerAnnotations: annotations,
      composerAnnotationsRef: annotationsRef,
      composerTerminalContexts: termContexts,
      composerTerminalContextsRef: termContextsRef,
      selectedProvider: provider,
      selectedModel: model,
      selectedProviderModels: providerModels,
      selectedPromptEffort: effort,
      selectedModelSelection: modelSel,
      runtimeMode: runMode,
      interactionMode: interactMode,
      envMode: env,
      showPlanFollowUpPrompt: planFollowUp,
      activeProposedPlan: proposedPlan,
      isOpencodePendingUserInputMode,
      activePendingUserInputRequestId,
      activePendingUserInput,
      bootstrapSourceThreadId,
      shouldAutoScrollRef: autoScrollRef,
    } = inputRef.current;

    if (!api || !thread) return;
    const trimmed = pRef.current.trim();
    if (isOpencodePendingUserInputMode && activePendingUserInputRequestId) {
      if (!trimmed) {
        return;
      }
      // Build answers keyed by question ID — works for all providers:
      // - Codex iterates Object.entries(answers) by questionId
      // - ClaudeCode passes answers directly to the SDK keyed by questionId
      // - Copilot reads answers["answer"] (its question ID) then falls back to first value
      // - OpenCode reads answers[requestId] then falls back to first value
      const questions = activePendingUserInput?.questions ?? [];
      const answers: Record<string, string> =
        questions.length > 0
          ? Object.fromEntries(questions.map((q) => [q.id, trimmed]))
          : { [activePendingUserInputRequestId]: trimmed };
      await inputRef.current.onRespondToUserInput(activePendingUserInputRequestId, answers);
      pRef.current = "";
      inputRef.current.clearComposerDraftContent(thread.id);
      inputRef.current.setComposerHighlightedItemId(null);
      inputRef.current.setComposerCursor(0);
      inputRef.current.setComposerTrigger(null);
      return;
    }
    if (sendBusy || connecting || inFlightRef.current) return;
    const promptForSend = pRef.current;
    const {
      trimmedPrompt,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: images.length,
      fileCount: files.length,
      annotationCount: annotations.length,
      terminalContexts: termContexts,
    });
    if (planFollowUp && proposedPlan) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmedPrompt,
        planMarkdown: proposedPlan.planMarkdown,
      });
      pRef.current = "";
      inputRef.current.clearComposerDraftContent(thread.id);
      inputRef.current.setComposerHighlightedItemId(null);
      inputRef.current.setComposerCursor(0);
      inputRef.current.setComposerTrigger(null);
      await inputRef.current.onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
      });
      return;
    }
    const standaloneSlashCommand =
      images.length === 0 &&
      files.length === 0 &&
      annotations.length === 0 &&
      sendableComposerTerminalContexts.length === 0
        ? parseStandaloneComposerSlashCommand(trimmedPrompt)
        : null;
    if (standaloneSlashCommand) {
      if (standaloneSlashCommand === "plan" || standaloneSlashCommand === "default") {
        inputRef.current.handleInteractionModeChange(standaloneSlashCommand);
      }
      pRef.current = "";
      inputRef.current.clearComposerDraftContent(thread.id);
      inputRef.current.setComposerHighlightedItemId(null);
      inputRef.current.setComposerCursor(0);
      inputRef.current.setComposerTrigger(null);
      return;
    }
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        });
      }
      return;
    }
    if (!project) return;
    const threadIdForSend = thread.id;
    const isFirstMessage = !isServer || thread.messages.length === 0;
    const baseBranchForWorktree =
      isFirstMessage && env === "worktree" && !thread.worktreePath ? thread.branch : null;
    const shouldCreateWorktree = isFirstMessage && env === "worktree" && !thread.worktreePath;
    if (shouldCreateWorktree && !thread.branch) {
      inputRef.current.setStoreThreadError(
        threadIdForSend,
        "Select a base branch before sending in New worktree mode.",
      );
      return;
    }
    if (shouldCreateWorktree && !project.cwd) {
      inputRef.current.setStoreThreadError(
        threadIdForSend,
        "New worktree mode is unavailable for chats without a project folder.",
      );
      return;
    }

    inFlightRef.current = true;
    inputRef.current.beginLocalDispatch({ preparingWorktree: Boolean(baseBranchForWorktree) });

    const composerImagesSnapshot = [...images];
    const composerFilesSnapshot = [...files];
    const composerAnnotationsSnapshot = [...annotations];
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
      provider,
      model,
      models: providerModels,
      effort,
      text: messageTextForSend || IMAGE_ONLY_BOOTSTRAP_PROMPT,
    });
    const turnAttachmentsPromise = Promise.all([
      ...composerImagesSnapshot.map(async (image) => ({
        type: "image" as const,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: await readFileAsDataUrl(image.file),
      })),
      ...composerFilesSnapshot.map(async (file) => {
        if (isElectron && file.filePath) {
          return {
            type: "file" as const,
            transport: "path" as const,
            name: file.name,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            filePath: file.filePath,
          };
        }
        if (isElectron) {
          throw new Error(`Missing filesystem path for attachment '${file.name}'.`);
        }
        // Web fallback: base64
        const dataUrl = file.file ? await readFileAsDataUrl(file.file) : "";
        return {
          type: "file" as const,
          transport: "base64" as const,
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          dataUrl,
        };
      }),
    ]);
    const optimisticAttachments: ChatAttachment[] = [
      ...composerImagesSnapshot.map((image) => ({
        type: "image" as const,
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        previewUrl: image.previewUrl,
      })),
      ...composerFilesSnapshot.map((file) => ({
        type: "file" as const,
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        ...(file.filePath ? { sourcePath: file.filePath } : {}),
      })),
    ];
    inputRef.current.setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user" as const,
        text: outgoingMessageText,
        ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
        createdAt: messageCreatedAt,
        streaming: false,
      },
    ]);
    autoScrollRef.current = true;
    inputRef.current.forceStickToBottom();

    inputRef.current.setThreadError(threadIdForSend, null);
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add({
        type: "warning",
        title: toastCopy.title,
        description: toastCopy.description,
      });
    }
    pRef.current = "";
    inputRef.current.clearComposerDraftContent(threadIdForSend);
    inputRef.current.setComposerHighlightedItemId(null);
    inputRef.current.setComposerCursor(0);
    inputRef.current.setComposerTrigger(null);

    let turnStartSucceeded = false;
    await (async () => {
      const threadCreateModelSelection: ModelSelection = modelSel;

      if (isServer) {
        await inputRef.current.persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          ...(model ? { modelSelection: modelSel } : {}),
          runtimeMode: runMode,
          interactionMode: interactMode,
        });
      }

      const turnAttachments = await turnAttachmentsPromise;
      const draftTitle = isDraft ? draftTitleFromMessage(promptForSend) : undefined;
      const bootstrap =
        isDraft || baseBranchForWorktree
          ? {
              ...(isDraft
                ? {
                    createThread: {
                      projectId: project.id,
                      title: draftTitle ?? thread.title,
                      modelSelection: threadCreateModelSelection,
                      runtimeMode: runMode,
                      interactionMode: interactMode,
                      branch: thread.branch,
                      worktreePath: thread.worktreePath,
                      createdAt: thread.createdAt,
                    },
                  }
                : {}),
              ...(baseBranchForWorktree
                ? {
                    prepareWorktree: {
                      projectCwd: project.cwd!,
                      baseBranch: baseBranchForWorktree,
                      branch: buildTemporaryWorktreeBranchName(),
                    },
                    runSetupScript: true,
                  }
                : {}),
            }
          : undefined;
      inputRef.current.beginLocalDispatch({ preparingWorktree: false });
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: threadIdForSend,
        message: {
          messageId: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          attachments: turnAttachments,
        },
        modelSelection: modelSel,
        runtimeMode: runMode,
        interactionMode: interactMode,
        ...(bootstrap ? { bootstrap } : {}),
        ...(bootstrapSourceThreadId ? { bootstrapSourceThreadId } : {}),
        ...(draftTitle ? { titleSeed: draftTitle } : {}),
        createdAt: messageCreatedAt,
      });
      if (bootstrapSourceThreadId) {
        inputRef.current.clearBootstrapSourceThreadId(threadIdForSend);
      }
      turnStartSucceeded = true;
      recordModelUsage(
        modelSel.provider,
        modelSel.model,
        "subProviderID" in modelSel ? modelSel.subProviderID : undefined,
      );
    })().catch(async (err: unknown) => {
      const { revokeUserMessagePreviewUrls } = await import("./ChatView.logic");
      if (
        !turnStartSucceeded &&
        pRef.current.length === 0 &&
        imagesRef.current.length === 0 &&
        filesRef.current.length === 0 &&
        annotationsRef.current.length === 0 &&
        termContextsRef.current.length === 0
      ) {
        inputRef.current.setOptimisticUserMessages((existing) => {
          const removed = existing.filter((message) => message.id === messageIdForSend);
          for (const message of removed) {
            revokeUserMessagePreviewUrls(message);
          }
          const next = existing.filter((message) => message.id !== messageIdForSend);
          return next.length === existing.length ? existing : next;
        });
        pRef.current = promptForSend;
        inputRef.current.setPrompt(promptForSend);
        inputRef.current.setComposerCursor(
          collapseExpandedComposerCursor(promptForSend, promptForSend.length),
        );
        inputRef.current.addComposerImagesToDraft(
          composerImagesSnapshot.map(cloneComposerImageForRetry),
        );
        inputRef.current.addComposerFilesToDraft(composerFilesSnapshot);
        inputRef.current.addComposerAnnotationsToDraft(composerAnnotationsSnapshot);
        inputRef.current.addComposerTerminalContextsToDraft(composerTerminalContextsSnapshot);
        inputRef.current.setComposerTrigger(
          detectComposerTrigger(promptForSend, promptForSend.length),
        );
      }
      inputRef.current.setThreadError(
        threadIdForSend,
        err instanceof Error ? err.message : "Failed to send message.",
      );
      // Clear bootstrapSourceThreadId on failure too — a failed dispatch
      // should not re-attempt bootstrap on the next retry because the context
      // has already been consumed (the server may have processed part of it).
      if (bootstrapSourceThreadId) {
        inputRef.current.clearBootstrapSourceThreadId(threadIdForSend);
      }
    });
    inFlightRef.current = false;
    if (!turnStartSucceeded) {
      inputRef.current.resetLocalDispatch();
    }
  }, []);
}
