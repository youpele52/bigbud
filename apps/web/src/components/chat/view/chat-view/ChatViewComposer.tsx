import { type MessageId } from "@bigbud/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
} from "~/logic/composer";
import { cn } from "~/lib/utils";

import { ContextWindowMeter } from "../../common/ContextWindowMeter";
import { ComposerAnnotationPreviews } from "../../composer/ComposerAnnotationPreviews";
import { ComposerAttachmentMenu } from "../../composer/ComposerAttachmentMenu";
import { type ComposerCommandItem } from "../../composer/ComposerCommandMenu";
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

import { ChatViewComposerHeader } from "./ChatViewComposerHeader";
import { ChatViewComposerMenuLayer } from "./ChatViewComposerMenuLayer";
import { type ChatViewBaseState } from "./chat-view-base-state.hooks";
import { type ChatViewComposerDerivedState } from "./chat-view-composer-derived.hooks";
import { type ChatViewInteractionsState } from "./chat-view-interactions.hooks";
import { type ChatViewRuntimeState } from "./chat-view-runtime.hooks";
import { type ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";

interface ChatViewComposerProps {
  base: ChatViewBaseState;
  composer: ChatViewComposerDerivedState;
  thread: ChatViewThreadDerivedState;
  runtime: ChatViewRuntimeState;
  interactions: ChatViewInteractionsState;
  onOpenReplySource: (messageId: MessageId) => void;
}

export function ChatViewComposer({
  base,
  composer,
  thread,
  runtime,
  interactions,
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

  /**
   * Injects transcript text into the composer the same way setPromptFromTraits
   * does in chat-view-interactions: update the store, sync promptRef, advance
   * the cursor to end, and schedule a focus on the editor. This ensures the
   * Lexical editor picks up the change on both web and Electron.
   */
  const onMicTranscript = useCallback(
    (text: string) => {
      if (text === base.promptRef.current) return;
      base.promptRef.current = text;
      base.setPrompt(text);
      base.setComposerCursor(base.collapseExpandedComposerCursor(text, text.length));
      base.setComposerTrigger(base.detectComposerTrigger(text, text.length));
      runtime.scheduleComposerFocus();
    },
    [base, runtime],
  );

  // Synthetic composer menu (opened from the + button, not from typed triggers)
  const [syntheticMenuKind, setSyntheticMenuKind] = useState<"agent" | "skill" | null>(null);
  const [syntheticMenuHighlightId, setSyntheticMenuHighlightId] = useState<string | null>(null);
  const [syntheticMenuSearch, setSyntheticMenuSearch] = useState("");
  const syntheticMenuRef = useRef<HTMLDivElement>(null);

  // Reset search when menu opens or closes
  useEffect(() => {
    setSyntheticMenuSearch("");
  }, [syntheticMenuKind]);

  // Dismiss synthetic menu on Escape
  useEffect(() => {
    if (!syntheticMenuKind) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSyntheticMenuKind(null);
        setSyntheticMenuHighlightId(null);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [syntheticMenuKind]);

  // Dismiss synthetic menu on click outside
  useEffect(() => {
    if (!syntheticMenuKind) return;
    const handler = (e: MouseEvent) => {
      if (syntheticMenuRef.current && !syntheticMenuRef.current.contains(e.target as Node)) {
        setSyntheticMenuKind(null);
        setSyntheticMenuHighlightId(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [syntheticMenuKind]);

  /** Insert a mention (agent or skill) at the current cursor position. */
  const insertMention = useCallback(
    (mention: string) => {
      const snapshot = base.composerEditorRef.current?.readSnapshot();
      const value = snapshot?.value ?? base.promptRef.current;
      const expandedCursor =
        snapshot?.expandedCursor ?? expandCollapsedComposerCursor(value, base.composerCursor);

      if (base.composerDraft.shellMode) {
        base.setComposerShellMode(false);
      }

      const prefix = expandedCursor > 0 && !/\s/.test(value[expandedCursor - 1] ?? "") ? " " : "";
      const insertion = prefix + mention;
      const newValue = value.slice(0, expandedCursor) + insertion + value.slice(expandedCursor);
      const newExpandedCursor = expandedCursor + insertion.length;
      const newCursor = collapseExpandedComposerCursor(newValue, newExpandedCursor);

      base.promptRef.current = newValue;
      base.setPrompt(newValue);
      base.setComposerCursor(newCursor);
      base.setComposerTrigger(detectComposerTrigger(newValue, newExpandedCursor));
      runtime.scheduleComposerFocus();
    },
    [base, runtime],
  );

  const syntheticAgentItems = useMemo<ComposerCommandItem[]>(() => {
    const query = syntheticMenuSearch.toLowerCase().trim();
    return composer.discoveredAgents
      .filter((agent) => {
        if (!query) return true;
        return (
          agent.name.toLowerCase().includes(query) ||
          agent.provider.toLowerCase().includes(query) ||
          (agent.description?.toLowerCase().includes(query) ?? false)
        );
      })
      .map((agent) => ({
        id: `agent:${agent.provider}:${agent.id}`,
        type: "agent" as const,
        agent,
        label: `@${agent.name}`,
        description: agent.description ?? "",
      }));
  }, [composer.discoveredAgents, syntheticMenuSearch]);

  const syntheticSkillItems = useMemo<ComposerCommandItem[]>(() => {
    const query = syntheticMenuSearch.toLowerCase().trim();
    return composer.discoveredSkills
      .filter((skill) => {
        if (!query) return true;
        const skillLabel = skill.displayName ?? skill.name;
        return (
          skill.name.toLowerCase().includes(query) ||
          skillLabel.toLowerCase().includes(query) ||
          skill.provider.toLowerCase().includes(query) ||
          (skill.description?.toLowerCase().includes(query) ?? false)
        );
      })
      .map((skill) => ({
        id: `provider-skill:${skill.provider}:${skill.id}`,
        type: "skill" as const,
        skill,
        label: `$${skill.displayName ?? skill.name}`,
        description: skill.description ?? "",
      }));
  }, [composer.discoveredSkills, syntheticMenuSearch]);

  const syntheticMenuItems =
    syntheticMenuKind === "agent"
      ? syntheticAgentItems
      : syntheticMenuKind === "skill"
        ? syntheticSkillItems
        : [];

  const onSyntheticMenuSelect = useCallback(
    (item: ComposerCommandItem) => {
      if (item.type === "agent") {
        insertMention(`@agent::${item.agent.name} `);
      } else if (item.type === "skill") {
        insertMention(`@skill::${item.skill.name} `);
      }
      setSyntheticMenuKind(null);
      setSyntheticMenuHighlightId(null);
    },
    [insertMention],
  );

  const onSyntheticMenuHighlight = useCallback((itemId: string | null) => {
    setSyntheticMenuHighlightId(itemId);
  }, []);

  const onSyntheticMenuSearchChange = useCallback((query: string) => {
    setSyntheticMenuSearch(query);
    setSyntheticMenuHighlightId(null);
  }, []);

  const onCallAgent = useCallback(() => {
    setSyntheticMenuKind("agent");
    setSyntheticMenuHighlightId(null);
  }, []);

  const onUseSkill = useCallback(() => {
    setSyntheticMenuKind("skill");
    setSyntheticMenuHighlightId(null);
  }, []);

  const onOpenReadDialog = useCallback(() => {
    base.setReadDocumentDialogOpen(true);
  }, [base]);

  const onSubmitReadUrl = useCallback(
    async (url: string) => {
      const nextPrompt = `/read ${url}`;
      base.promptRef.current = nextPrompt;
      base.setPrompt(nextPrompt);
      base.setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
      base.setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      interactions.onSend();
    },
    [base, interactions],
  );

  const onSubmitReadFiles = useCallback(
    async (files: File[]) => {
      interactions.addComposerFiles(files);
      const nextPrompt =
        base.promptRef.current.trim().length > 0
          ? base.promptRef.current
          : "Read the attached documents and use them as context.";
      base.promptRef.current = nextPrompt;
      base.setPrompt(nextPrompt);
      base.setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
      base.setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      window.requestAnimationFrame(() => {
        interactions.onSend();
      });
    },
    [base, interactions],
  );

  const onUseHandoffFromMeter = useCallback(() => {
    const nextPrompt = "/skills handoff";
    base.promptRef.current = nextPrompt;
    base.setPrompt(nextPrompt);
    base.setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
    base.setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
    interactions.onSend();
  }, [base, interactions]);

  const onCompactFromMeter = useCallback(() => {
    const nextPrompt = "/compact";
    base.promptRef.current = nextPrompt;
    base.setPrompt(nextPrompt);
    base.setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
    base.setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
    interactions.onSend();
  }, [base, interactions]);

  const handoffAvailable = composer.discoveredSkills.some((skill) => skill.name === "handoff");
  const compactAvailable = composer.supportsCompact;

  return (
    <form
      ref={base.composerFormRef}
      onSubmit={interactions.onSend}
      className="mx-auto w-full min-w-0 max-w-[52rem]"
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
          <ChatViewComposerHeader thread={thread} interactions={interactions} />

          <div
            className={cn(
              "relative px-3 pb-2 sm:px-4",
              thread.hasComposerHeader ? "pt-2.5 sm:pt-3" : "pt-3.5 sm:pt-4",
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
                "flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-2.5 pb-2.5 sm:px-3 sm:pb-3",
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
                activePlan={Boolean(thread.activePlan)}
                sidebarProposedPlan={Boolean(thread.sidebarProposedPlan)}
                planSidebarOpen={base.planSidebarOpen}
                planSidebarLabel={thread.planSidebarLabel}
                interactionMode={base.interactionMode}
                runtimeMode={base.runtimeMode}
                providerTraitsMenuContent={interactions.providerTraitsMenuContent}
                onProviderModelSelect={interactions.onProviderModelSelect}
                onProviderUnlock={() => base.setProviderUnlocked(true)}
                onToggleInteractionMode={runtime.toggleInteractionMode}
                onTogglePlanSidebar={runtime.togglePlanSidebar}
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
