import { cn } from "~/lib/utils";

import { ContextWindowMeter } from "../../common/ContextWindowMeter";
import { ComposerCommandMenu } from "../../composer/ComposerCommandMenu";
import { ComposerFooterLeading } from "../../composer/ComposerFooterLeading";
import { ComposerImagePreviews } from "../../composer/ComposerImagePreviews";
import { ComposerPendingApprovalActions } from "../../composer/ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "../../composer/ComposerPendingApprovalPanel";
import { ComposerPlanFollowUpBanner } from "../../composer/ComposerPlanFollowUpBanner";
import { ComposerPrimaryActions } from "../../composer/ComposerPrimaryActions";
import { ComposerPromptEditor } from "../../composer/ComposerPromptEditor";

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
}

export function ChatViewComposer({
  base,
  composer,
  thread,
  runtime,
  interactions,
}: ChatViewComposerProps) {
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
          {thread.activePendingApproval ? (
            <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
              <ComposerPendingApprovalPanel
                approval={thread.activePendingApproval}
                pendingCount={thread.pendingApprovals.length}
              />
            </div>
          ) : thread.showPlanFollowUpPrompt && thread.activeProposedPlan ? (
            <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
              <ComposerPlanFollowUpBanner
                key={thread.activeProposedPlan.id}
                planTitle={interactions.planTitle}
              />
            </div>
          ) : null}

          <div
            className={cn(
              "relative px-3 pb-2 sm:px-4",
              thread.hasComposerHeader ? "pt-2.5 sm:pt-3" : "pt-3.5 sm:pt-4",
            )}
          >
            {composer.composerMenuOpen && !thread.isComposerApprovalState ? (
              <div className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
                <ComposerCommandMenu
                  items={composer.composerMenuItems}
                  resolvedTheme={base.resolvedTheme}
                  isLoading={interactions.isComposerMenuLoading}
                  triggerKind={composer.composerTriggerKind}
                  activeItemId={composer.activeComposerMenuItem?.id ?? null}
                  onHighlightedItemChange={
                    interactions.composerCommandHandlers.onComposerMenuItemHighlighted
                  }
                  onSelect={interactions.composerCommandHandlers.onSelectComposerItem}
                />
              </div>
            ) : null}

            {!thread.isComposerApprovalState && !thread.isOpencodePendingUserInputMode ? (
              <ComposerImagePreviews
                composerImages={base.composerImages}
                nonPersistedComposerImageIdSet={composer.nonPersistedComposerImageIdSet}
                onRemoveImage={base.removeComposerImageFromDraft}
                onExpandImage={base.setExpandedImage}
              />
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
                isComposerFooterCompact={runtime.scrollBehavior.isComposerFooterCompact}
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
                providerTraitsPicker={interactions.providerTraitsPicker}
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
                {thread.activeContextWindow ? (
                  <ContextWindowMeter usage={thread.activeContextWindow} />
                ) : null}
                {thread.isPreparingWorktree ? (
                  <span className="text-muted-foreground/70 text-xs">Preparing worktree...</span>
                ) : null}
                <ComposerPrimaryActions
                  compact={runtime.scrollBehavior.isComposerPrimaryActionsCompact}
                  pendingAction={interactions.pendingAction}
                  isRunning={thread.phase === "running"}
                  showPlanFollowUpPrompt={thread.showPlanFollowUpPrompt}
                  promptHasText={base.prompt.trim().length > 0}
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
              </div>
            </div>
          )}
        </div>
      </div>
    </form>
  );
}
