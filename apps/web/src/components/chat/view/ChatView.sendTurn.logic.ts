import { useCallback, useRef } from "react";
import { parseStandaloneComposerSlashCommand } from "../../../logic/composer";
import { resolvePlanFollowUpSubmission } from "../../../logic/proposed-plan";
import {
  deriveComposerSendState,
  buildExpiredTerminalContextToastCopy,
  formatOutgoingPrompt,
  appendBrowserAnnotationsToPrompt,
} from "./ChatView.logic";
import { appendTerminalContextsToPrompt } from "../../../lib/terminalContext";
import { toastManager } from "../../ui/toast";
import { readNativeApi } from "../../../rpc/nativeApi";
import { newCommandId, newMessageId } from "~/lib/utils";
import { recordModelUsage } from "../../../models/recentlyUsedModels";
import { useRemoteExecutionAccessGate } from "../../../hooks/useRemoteExecutionAccessGate";
import type { ChatAttachment } from "../../../models/types";
import { resolveWorkspaceExecutionTargetId } from "../../../lib/providerExecutionTargets";
import { DEFAULT_THREAD_TITLE, draftTitleFromMessage } from "./ChatView.threadTitle.logic";
import {
  buildOptimisticAttachments,
  buildThreadBootstrap,
  buildTurnAttachments,
  getWorktreeValidationError,
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
  resolveSendContext,
  restoreMessageComposerDraftAfterFailure,
  restoreShellComposerDraftAfterFailure,
} from "./ChatView.sendTurn.helpers";
import type { UseOnSendInput } from "./ChatView.sendTurn.types";

/** Returns the `onSend` handler for the composer form. */
export function useOnSend(input: UseOnSendInput) {
  // Stable ref to avoid stale closure in the returned function
  const inputRef = useRef(input);
  inputRef.current = input;
  const { ensureRemoteExecutionTargetAccess } = useRemoteExecutionAccessGate();

  const onSend = useCallback(
    async (e?: { preventDefault: () => void }) => {
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
        isComposerShellMode,
        envMode: env,
        showPlanFollowUpPrompt: planFollowUp,
        activeProposedPlan: proposedPlan,
        isOpencodePendingUserInputMode,
        activePendingUserInputRequestId,
        activePendingUserInput,
        bootstrapSourceThreadId,
        replyTarget,
        shouldAutoScrollRef: autoScrollRef,
      } = inputRef.current;

      if (!api || !thread) return;
      const resetComposerDraft = () => {
        pRef.current = "";
        inputRef.current.clearComposerDraftContent(thread.id);
        inputRef.current.setComposerHighlightedItemId(null);
        inputRef.current.setComposerCursor(0);
        inputRef.current.setComposerTrigger(null);
      };
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
        resetComposerDraft();
        return;
      }
      if (sendBusy || connecting || inFlightRef.current) return;
      if (planFollowUp && proposedPlan) {
        const followUp = resolvePlanFollowUpSubmission({
          draftText: trimmed,
          planMarkdown: proposedPlan.planMarkdown,
        });
        resetComposerDraft();
        await inputRef.current.onSubmitPlanFollowUp({
          text: followUp.text,
          interactionMode: followUp.interactionMode,
        });
        return;
      }
      if (isComposerShellMode) {
        if (
          images.length > 0 ||
          files.length > 0 ||
          annotations.length > 0 ||
          termContexts.length > 0
        ) {
          inputRef.current.setThreadError(
            thread.id,
            "Shell commands can't include attachments or inline context.",
          );
          return;
        }
        const shellPromptForSend = pRef.current;
        const shellCommand = shellPromptForSend.trimStart();
        if (!shellCommand) {
          inputRef.current.setThreadError(thread.id, "Enter a shell command.");
          return;
        }
        if (!project) return;

        const { threadIdForSend, isFirstMessage, baseBranchForWorktree, shouldCreateWorktree } =
          resolveSendContext({
            thread,
            isServer,
            envMode: env,
          });
        const worktreeValidationError = getWorktreeValidationError({
          shouldCreateWorktree,
          thread,
          project,
        });
        if (worktreeValidationError) {
          inputRef.current.setStoreThreadError(threadIdForSend, worktreeValidationError);
          return;
        }
        const remoteCwd = thread.worktreePath ?? project.cwd;
        const remoteReady = await ensureRemoteExecutionTargetAccess({
          executionTargetId:
            thread.workspaceExecutionTargetId !== undefined ||
            thread.executionTargetId !== undefined
              ? resolveWorkspaceExecutionTargetId(thread)
              : resolveWorkspaceExecutionTargetId(project),
          ...(remoteCwd ? { cwd: remoteCwd } : {}),
          onVerified: () => onSend(),
          resumeOnUnlockOnly: true,
        });
        if (!remoteReady) {
          return;
        }

        const messageIdForSend = newMessageId();
        const messageCreatedAt = new Date().toISOString();

        inFlightRef.current = true;
        inputRef.current.beginLocalDispatch({ preparingWorktree: Boolean(baseBranchForWorktree) });
        inputRef.current.setThreadError(threadIdForSend, null);
        autoScrollRef.current = true;
        inputRef.current.forceStickToBottom();
        resetComposerDraft();

        let shellRunSucceeded = false;
        await (async () => {
          if (isServer) {
            await inputRef.current.persistThreadSettingsForNextTurn({
              threadId: threadIdForSend,
              createdAt: messageCreatedAt,
              modelSelection: modelSel,
              runtimeMode: runMode,
              interactionMode: interactMode,
            });
          }

          const bootstrap = buildThreadBootstrap({
            thread,
            project,
            isDraft,
            isFirstMessage,
            promptText: shellCommand,
            modelSelection: modelSel,
            runtimeMode: runMode,
            interactionMode: interactMode,
            baseBranchForWorktree,
          });
          inputRef.current.beginLocalDispatch({ preparingWorktree: false });
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
              pRef.current.length === 0 &&
              imagesRef.current.length === 0 &&
              filesRef.current.length === 0 &&
              annotationsRef.current.length === 0 &&
              termContextsRef.current.length === 0,
            messageIdForSend,
            promptText: shellPromptForSend,
            promptRef: pRef,
            setOptimisticUserMessages: inputRef.current.setOptimisticUserMessages,
            setPrompt: inputRef.current.setPrompt,
            setComposerShellMode: inputRef.current.setComposerShellMode,
            setComposerCursor: (next) => {
              inputRef.current.setComposerCursor(next);
            },
            setComposerTrigger: (trigger) => {
              inputRef.current.setComposerTrigger(trigger);
            },
          });
          inputRef.current.setThreadError(
            threadIdForSend,
            err instanceof Error ? err.message : "Failed to run shell command.",
          );
        });
        inFlightRef.current = false;
        inputRef.current.resetLocalDispatch();
        return;
      }
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
        resetComposerDraft();
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
      const { threadIdForSend, isFirstMessage, baseBranchForWorktree, shouldCreateWorktree } =
        resolveSendContext({
          thread,
          isServer,
          envMode: env,
        });
      const worktreeValidationError = getWorktreeValidationError({
        shouldCreateWorktree,
        thread,
        project,
      });
      if (worktreeValidationError) {
        inputRef.current.setStoreThreadError(threadIdForSend, worktreeValidationError);
        return;
      }
      const remoteCwd = thread.worktreePath ?? project.cwd;
      const remoteReady = await ensureRemoteExecutionTargetAccess({
        executionTargetId:
          thread.workspaceExecutionTargetId !== undefined || thread.executionTargetId !== undefined
            ? resolveWorkspaceExecutionTargetId(thread)
            : resolveWorkspaceExecutionTargetId(project),
        ...(remoteCwd ? { cwd: remoteCwd } : {}),
        onVerified: () => onSend(),
        resumeOnUnlockOnly: true,
      });
      if (!remoteReady) {
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
      const turnAttachmentsPromise = buildTurnAttachments(
        composerImagesSnapshot,
        composerFilesSnapshot,
      );
      const optimisticAttachments: ChatAttachment[] = buildOptimisticAttachments(
        composerImagesSnapshot,
        composerFilesSnapshot,
      );
      inputRef.current.setOptimisticUserMessages((existing) => [
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
      resetComposerDraft();

      let turnStartSucceeded = false;
      await (async () => {
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
          modelSelection: modelSel,
          runtimeMode: runMode,
          interactionMode: interactMode,
          baseBranchForWorktree,
        });
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
            ...(replyTarget ? { replyToMessageId: replyTarget.messageId } : {}),
          },
          modelSelection: modelSel,
          runtimeMode: runMode,
          interactionMode: interactMode,
          ...(bootstrap ? { bootstrap } : {}),
          ...(bootstrapSourceThreadId ? { bootstrapSourceThreadId } : {}),
          ...(seededTitle ? { titleSeed: seededTitle } : {}),
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
        restoreMessageComposerDraftAfterFailure({
          currentDraftEmpty:
            !turnStartSucceeded &&
            pRef.current.length === 0 &&
            imagesRef.current.length === 0 &&
            filesRef.current.length === 0 &&
            annotationsRef.current.length === 0 &&
            termContextsRef.current.length === 0,
          messageIdForSend,
          promptText: promptForSend,
          promptRef: pRef,
          replyTarget,
          composerImages: composerImagesSnapshot,
          composerFiles: composerFilesSnapshot,
          composerAnnotations: composerAnnotationsSnapshot,
          composerTerminalContexts: composerTerminalContextsSnapshot,
          setOptimisticUserMessages: inputRef.current.setOptimisticUserMessages,
          revokeUserMessagePreviewUrls,
          setPrompt: inputRef.current.setPrompt,
          setComposerCursor: (next) => {
            inputRef.current.setComposerCursor(next);
          },
          addComposerImagesToDraft: inputRef.current.addComposerImagesToDraft,
          addComposerFilesToDraft: inputRef.current.addComposerFilesToDraft,
          addComposerAnnotationsToDraft: inputRef.current.addComposerAnnotationsToDraft,
          addComposerTerminalContextsToDraft: inputRef.current.addComposerTerminalContextsToDraft,
          setReplyTarget: (nextReplyTarget) => {
            inputRef.current.setReplyTarget(threadIdForSend, nextReplyTarget);
          },
          setComposerTrigger: (trigger) => {
            inputRef.current.setComposerTrigger(trigger);
          },
        });
        inputRef.current.setThreadError(
          threadIdForSend,
          err instanceof Error ? err.message : "Failed to send message.",
        );
        if (bootstrapSourceThreadId) {
          inputRef.current.clearBootstrapSourceThreadId(threadIdForSend);
        }
      });
      inFlightRef.current = false;
      if (!turnStartSucceeded) {
        inputRef.current.resetLocalDispatch();
      }
    },
    [ensureRemoteExecutionTargetAccess],
  );

  return onSend;
}
