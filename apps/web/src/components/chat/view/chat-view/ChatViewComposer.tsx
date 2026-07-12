import { type MessageId } from "@bigbud/contracts";
import { useRef, useState } from "react";
import { cn } from "~/lib/utils";

import { ContextWindowMeter } from "../../common/ContextWindowMeter";
import { ComposerAnnotationPreviews } from "../../composer/ComposerAnnotationPreviews";
import { ComposerAttachmentMenu } from "../../composer/ComposerAttachmentMenu";
import { ComposerFooterLeading } from "../../composer/ComposerFooterLeading";
import { ComposerFilePreviews } from "../../composer/ComposerFilePreviews";
import { ComposerImagePreviews } from "../../composer/ComposerImagePreviews";
import { ComposerListeningBar } from "../../composer/ComposerListeningBar";
import { ComposerMicButton, type ComposerMicButtonHandle } from "../../composer/ComposerMicButton";
import { ComposerPendingApprovalActions } from "../../composer/ComposerPendingApprovalActions";
import { ComposerPrimaryActions } from "../../composer/ComposerPrimaryActions";
import { ComposerPromptEditor } from "../../composer/ComposerPromptEditor";
import { ComposerReadDialog } from "../../composer/ComposerReadDialog";
import { ComposerReplyPreview } from "../../composer/ComposerReplyPreview";
import { ThreadActivityDots } from "../../common/threadActivityIndicator";
import { isBrowserAnnotationAttachment } from "../../../../stores/composer";
import { useSttStore } from "../../../../stores/stt/stt.store";

import { useChatViewComposerActions } from "./ChatViewComposer.actions";
import { ChatViewComposerHeader } from "./ChatViewComposerHeader";
import { ChatViewComposerMenuLayer } from "./ChatViewComposerMenuLayer";
import { useChatViewComposerSyntheticMenu } from "./ChatViewComposer.syntheticMenu";
import { type ChatViewBaseState } from "./chat-view-base-state.hooks";
import { type ChatViewComposerDerivedState } from "./chat-view-composer-derived.hooks";
import { type ChatViewInteractionsState } from "./chat-view-interactions.hooks";
import { type ChatViewRuntimeState } from "./chat-view-runtime.hooks";
import { type ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";

interface ChatViewComposerProps {
  base: ChatViewBaseState;
  className?: string;
  compact?: boolean | undefined;
  composer: ChatViewComposerDerivedState;
  thread: ChatViewThreadDerivedState;
  runtime: ChatViewRuntimeState;
  interactions: ChatViewInteractionsState;
  onOpenOrchestra: () => void;
  onOpenSideChat?: (() => void) | undefined;
  onOpenReplySource: (messageId: MessageId) => void;
}

export function ChatViewComposer({
  base,
  className,
  compact = false,
  composer,
  thread,
  runtime,
  interactions,
  onOpenOrchestra,
  onOpenSideChat,
  onOpenReplySource,
}: ChatViewComposerProps) {
  const { keyVerified } = useSttStore();
  const promptHasText = base.prompt.trim().length > 0;
  const isDefaultComposerState =
    !interactions.pendingAction && thread.phase !== "running" && !thread.showPlanFollowUpPrompt;
  const micReplacesSend =
    keyVerified === true && !base.composerSendState.hasSendableContent && isDefaultComposerState;

  // Track whether the mic is actively recording so we can show the listening
  // bar and hide the send button.
  const [isRecording, setIsRecording] = useState(false);
  const micRef = useRef<ComposerMicButtonHandle>(null);
  const activeReplyTarget = base.composerDraft.replyTarget;
  const {
    insertMention,
    onCompactFromMeter,
    onMicTranscript,
    onOpenReadDialog,
    onSubmitReadFiles,
    onSubmitReadUrl,
    onUseHandoffFromMeter,
  } = useChatViewComposerActions({ base, runtime, interactions });
  const {
    onCallAgent,
    onOpenDiscoveryItemSourcePath,
    onSyntheticMenuHighlight,
    onSyntheticMenuSearchChange,
    onSyntheticMenuSelect,
    onUseSkill,
    syntheticMenuHighlightId,
    syntheticMenuItems,
    syntheticMenuKind,
    syntheticMenuRef,
    syntheticMenuSearch,
  } = useChatViewComposerSyntheticMenu({
    composer,
    activeProjectCwd: base.activeProjectCwd,
    insertMention,
  });

  const handoffAvailable = base.isServerThread;
  const compactAvailable = composer.supportsCompact;

  return (
    <form
      ref={base.composerFormRef}
      onSubmit={interactions.onSend}
      className={cn("mx-auto w-full min-w-0 max-w-[52rem]", className)}
      data-chat-composer-form="true"
      onDragEnter={interactions.onComposerDragEnter}
      onDragOver={interactions.onComposerDragOver}
      onDragLeave={interactions.onComposerDragLeave}
      onDrop={interactions.onComposerDrop}
    >
      <div
        className={cn(
          "group rounded-[22px] p-px transition-colors duration-200",
          composer.composerProviderState.composerFrameClassName,
        )}
      >
        <div
          className={cn(
            "rounded-[20px] border bg-card transition-colors duration-200 has-focus-visible:border-ring/45",
            base.isDragOverComposer ? "border-primary/70 bg-accent/30" : "border-border",
            composer.composerProviderState.composerSurfaceClassName,
          )}
        >
          {!compact && <ChatViewComposerHeader thread={thread} interactions={interactions} />}

          <div
            className={cn(
              "relative px-3 pb-2 sm:px-4",
              compact
                ? "pt-2 pb-1.5"
                : thread.hasComposerHeader
                  ? "pt-2.5 sm:pt-3"
                  : "pt-3.5 sm:pt-4",
            )}
          >
            <ChatViewComposerMenuLayer
              syntheticMenuKind={syntheticMenuKind}
              syntheticMenuRef={syntheticMenuRef}
              syntheticMenuItems={syntheticMenuItems}
              syntheticMenuHighlightId={syntheticMenuHighlightId}
              syntheticMenuSearch={syntheticMenuSearch}
              composer={composer}
              interactions={interactions}
              resolvedTheme={base.resolvedTheme}
              disabled={thread.isComposerApprovalState}
              onSyntheticMenuHighlight={onSyntheticMenuHighlight}
              onSyntheticMenuSelect={onSyntheticMenuSelect}
              onSyntheticMenuSearchChange={onSyntheticMenuSearchChange}
              onOpenDiscoveryItemSourcePath={onOpenDiscoveryItemSourcePath}
            />

            {!thread.isComposerApprovalState && !thread.isOpencodePendingUserInputMode ? (
              <>
                {activeReplyTarget &&
                !thread.showPlanFollowUpPrompt &&
                !base.composerDraft.shellMode ? (
                  <ComposerReplyPreview
                    replyTarget={activeReplyTarget}
                    onClear={() => base.setComposerReplyTarget(base.activeThread!.id, null)}
                    onOpenSource={() => onOpenReplySource(activeReplyTarget.messageId)}
                  />
                ) : null}
                <ComposerImagePreviews
                  composerImages={base.composerImages}
                  nonPersistedComposerImageIdSet={composer.nonPersistedComposerImageIdSet}
                  onRemoveImage={base.removeComposerImageFromDraft}
                  onExpandImage={base.setExpandedImage}
                />
                <ComposerAnnotationPreviews
                  annotations={base.composerAnnotations}
                  images={base.composerImages}
                  onRemoveAnnotation={base.removeComposerAnnotationFromDraft}
                  onClearAnnotations={() => {
                    for (const annotation of base.composerAnnotations) {
                      if (isBrowserAnnotationAttachment(annotation)) {
                        base.removeComposerImageFromDraft(annotation.imageId);
                      }
                      base.removeComposerAnnotationFromDraft(annotation.id);
                    }
                  }}
                />
                <ComposerFilePreviews
                  composerFiles={base.composerFiles}
                  resolvedTheme={base.resolvedTheme}
                  onRemoveFile={base.removeComposerFileFromDraft}
                  onToggleWatchForCompletion={base.toggleComposerFileWatchForCompletion}
                />
              </>
            ) : null}

            <ComposerPromptEditor
              ref={base.composerEditorRef}
              value={thread.isComposerApprovalState ? "" : base.prompt}
              cursor={base.composerCursor}
              terminalContexts={
                !thread.isComposerApprovalState && !thread.isOpencodePendingUserInputMode
                  ? base.composerTerminalContexts
                  : []
              }
              discoveredSkills={composer.discoveredSkills}
              onRemoveTerminalContext={base.removeComposerTerminalContextFromDraft}
              onChange={interactions.composerCommandHandlers.onPromptChange}
              onCommandKeyDown={interactions.composerCommandHandlers.onComposerCommandKey}
              onPaste={interactions.onComposerPaste}
              placeholder={
                thread.isComposerApprovalState
                  ? (thread.activePendingApproval?.detail ??
                    "Resolve this approval request to continue")
                  : base.composerDraft.shellMode
                    ? "Enter shell command"
                    : thread.isOpencodePendingUserInputMode
                      ? "Type your answer to continue..."
                      : thread.showPlanFollowUpPrompt && thread.activeProposedPlan
                        ? "Add feedback to refine the plan, or leave this blank to implement it"
                        : thread.phase === "disconnected"
                          ? "What are we working on?"
                          : "Ask anything, @tag files/folders, or use / to show available commands"
              }
              disabled={base.isConnecting || thread.isComposerApprovalState}
              {...(compact ? { className: "min-h-9 max-h-20 leading-5" } : {})}
            />
          </div>

          {thread.activePendingApproval ? (
            <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
              <ComposerPendingApprovalActions
                requestId={thread.activePendingApproval.requestId}
                isResponding={runtime.turnActions.respondingRequestIds.includes(
                  thread.activePendingApproval.requestId,
                )}
                sessionApprovalAvailable={thread.activePendingApproval.sessionApprovalAvailable}
                sessionApprovalLabel={thread.activePendingApproval.sessionApprovalLabel}
                onRespondToApproval={runtime.turnActions.onRespondToApproval}
              />
            </div>
          ) : (
            <div
              data-chat-composer-footer="true"
              data-chat-composer-footer-compact={
                runtime.scrollBehavior.isComposerFooterCompact ? "true" : "false"
              }
              className={cn(
                compact
                  ? "flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-2.5 pb-2"
                  : "flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-2.5 pb-2.5 sm:px-3 sm:pb-3",
                runtime.scrollBehavior.isComposerFooterCompact ? "gap-1.5" : "gap-2 sm:gap-0",
              )}
            >
              <ComposerFooterLeading
                selectedProvider={composer.selectedProvider}
                selectedModelForPickerWithCustomFallback={
                  composer.selectedModelForPickerWithCustomFallback
                }
                lockedProvider={composer.lockedProvider}
                providerStatuses={composer.providerStatuses}
                modelOptionsByProvider={composer.modelOptionsByProvider}
                composerProviderState={composer.composerProviderState}
                hasThreadStarted={composer.hasThreadStarted}
                planCardOpen={base.planCardOpen}
                planCardLabel={thread.planCardLabel}
                interactionMode={base.interactionMode}
                runtimeMode={base.runtimeMode}
                providerTraitsMenuContent={interactions.providerTraitsMenuContent}
                onOpenOrchestra={onOpenOrchestra}
                onOpenSideChat={onOpenSideChat}
                sideChatDisabled={!base.isServerThread}
                onProviderModelSelect={interactions.onProviderModelSelect}
                onProviderUnlock={() => base.setProviderUnlocked(true)}
                onToggleInteractionMode={runtime.toggleInteractionMode}
                onTogglePlanCard={runtime.togglePlanCard}
                onRuntimeModeChange={runtime.handleRuntimeModeChange}
              />

              <div
                data-chat-composer-actions="right"
                data-chat-composer-primary-actions-compact={
                  runtime.scrollBehavior.isComposerPrimaryActionsCompact ? "true" : "false"
                }
                className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
              >
                {isRecording ? (
                  // Listening bar replaces mic + send while STT is active.
                  <ComposerListeningBar onStop={() => micRef.current?.stopRecording()} />
                ) : (
                  <>
                    {thread.activeContextWindow ? (
                      <ContextWindowMeter
                        usage={thread.activeContextWindow}
                        handoffAvailable={handoffAvailable}
                        compactAvailable={compactAvailable}
                        onUseHandoff={onUseHandoffFromMeter}
                        onCompact={onCompactFromMeter}
                      />
                    ) : null}
                    {thread.isPreparingWorktree ? (
                      <span className="text-muted-foreground/70 text-xs">
                        Preparing worktree...
                      </span>
                    ) : null}
                    {thread.isCompacting ? (
                      <span className="inline-flex items-center gap-1.5 text-warning text-xs">
                        <span>Compacting context</span>
                        <span aria-hidden="true" className="inline-flex items-center gap-[3px]">
                          <ThreadActivityDots tone="compacting" dotClassName="h-1 w-1" />
                        </span>
                      </span>
                    ) : null}
                    <input
                      ref={interactions.fileInputRef}
                      type="file"
                      multiple
                      className="sr-only"
                      tabIndex={-1}
                      onChange={interactions.onFileInputChange}
                    />
                    <ComposerAttachmentMenu
                      onAttachFiles={interactions.onAttachFiles}
                      onOpenReadDialog={onOpenReadDialog}
                      onCallAgent={onCallAgent}
                      onUseSkill={onUseSkill}
                      disabled={base.isConnecting || thread.isComposerApprovalState}
                    />
                  </>
                )}
                {/* Always mounted outside the ternary so micRef is never null
                    while recording. Positioned here so it sits directly left of
                    the send button in normal (non-recording) flow. */}
                <span aria-hidden={isRecording} className={isRecording ? "hidden" : ""}>
                  <ComposerMicButton
                    ref={micRef}
                    prompt={base.prompt}
                    onTranscript={onMicTranscript}
                    onRecordingChange={setIsRecording}
                    disabled={base.isConnecting || thread.isComposerApprovalState}
                  />
                </span>
                {!isRecording && !micReplacesSend && (
                  <ComposerPrimaryActions
                    compact={runtime.scrollBehavior.isComposerPrimaryActionsCompact}
                    pendingAction={interactions.pendingAction}
                    isRunning={thread.activeSessionTurnRunning}
                    showPlanFollowUpPrompt={thread.showPlanFollowUpPrompt}
                    promptHasText={promptHasText}
                    isSendBusy={thread.isSendBusy}
                    isConnecting={base.isConnecting}
                    isPreparingWorktree={thread.isPreparingWorktree}
                    hasSendableContent={base.composerSendState.hasSendableContent}
                    onPreviousPendingQuestion={
                      interactions.pendingUserInputHandlers.onPreviousActivePendingUserInputQuestion
                    }
                    onInterrupt={() => {
                      void runtime.turnActions.onInterrupt();
                    }}
                    onImplementPlanInNewThread={() => {
                      void interactions.planHandlers.onImplementPlanInNewThread();
                    }}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      <ComposerReadDialog
        open={base.readDocumentDialogOpen}
        onOpenChange={base.setReadDocumentDialogOpen}
        onSubmitUrl={onSubmitReadUrl}
        onSubmitFiles={onSubmitReadFiles}
      />
    </form>
  );
}
