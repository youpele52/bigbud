import {
  type ApprovalRequestId,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderKind,
  type ServerProvider,
  type UserInputQuestion,
} from "@bigbud/contracts";
import { ChevronLeftIcon } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";

import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
  setPendingUserInputCustomAnswer,
} from "~/logic/user-input";
import { composerSurfaceStyles } from "~/components/chat/composer/ComposerSurface.styles";

import type { MobilePendingApproval, MobilePendingUserInput } from "../../../../lib/mobileModels";
import { cn } from "../../../../lib/cn";
import type { MobileCommandDeliveryStatus } from "../../../../lib/mobileCommandDelivery.logic";
import { MobileComposerContextBar } from "./MobileComposerContextBar";
import { MobileComposerApproval } from "./MobileComposer.approval";
import { MobileComposerDeliveryNotice } from "./MobileComposerDeliveryNotice";
import { shouldHandleMobileComposerEnter } from "./MobileComposer.logic";
import { MobileComposerModelPicker } from "./MobileComposerModelPicker";
import { MobileComposerPendingUserInput } from "./MobileComposerPendingUserInput";
import { MobileComposerSendIcon } from "./MobileComposerSendIcon";
import { MobileComposerStopIcon } from "./MobileComposerStopIcon";
import { Button } from "../../../ui/button";

interface MobileComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean | undefined;
  stateDependentActionsDisabled?: boolean | undefined;
  placeholder?: string | undefined;
  projectTitle?: string | undefined;
  isGitRepo?: boolean | undefined;
  activeThreadBranch?: string | null | undefined;
  activeWorktreePath?: string | null | undefined;
  currentGitBranch?: string | null | undefined;
  isRunning?: boolean | undefined;
  workingVerb?: string | undefined;
  onStop?: (() => void) | undefined;
  pendingApproval?: MobilePendingApproval | null | undefined;
  onRespondToApproval?: (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => void;
  pendingUserInput?: MobilePendingUserInput | null | undefined;
  userInputAnswers?: Record<string, PendingUserInputDraftAnswer> | undefined;
  userInputQuestionIndex?: number | undefined;
  isRespondingToUserInput?: boolean | undefined;
  onToggleUserInputOption?: (
    questionId: string,
    option: UserInputQuestion["options"][number],
    optionIndex: number,
  ) => void;
  onAdvanceUserInput?: () => void;
  onPreviousUserInputQuestion?: () => void;
  availableProviders?: ReadonlyArray<ServerProvider>;
  modelSelection?: ModelSelection | null;
  onModelSelectionChange?: (next: ModelSelection) => void;
  lockedProvider?: ProviderKind | null;
  onProviderUnlock?: () => void;
  onCheckDelivery?: () => void;
  deliveryState?: MobileCommandDeliveryStatus;
  storageWarning?: string | null;
}

export function MobileComposer({
  value,
  onChange,
  onSend,
  disabled = false,
  stateDependentActionsDisabled = false,
  placeholder = "What are we working on?",
  projectTitle,
  isGitRepo = false,
  activeThreadBranch = null,
  activeWorktreePath = null,
  currentGitBranch = null,
  isRunning = false,
  workingVerb,
  onStop,
  pendingApproval = null,
  onRespondToApproval,
  pendingUserInput = null,
  userInputAnswers = {},
  userInputQuestionIndex = 0,
  isRespondingToUserInput = false,
  onToggleUserInputOption,
  onAdvanceUserInput,
  onPreviousUserInputQuestion,
  availableProviders = [],
  modelSelection = null,
  onModelSelectionChange,
  lockedProvider = null,
  onProviderUnlock,
  onCheckDelivery,
  deliveryState = "idle",
  storageWarning = null,
}: MobileComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isApprovalMode = pendingApproval !== null;
  const isLearningSkillProposal = pendingApproval?.requestId.startsWith("learning-skill:") ?? false;
  const isUserInputMode = pendingUserInput !== null;
  const userInputProgress =
    pendingUserInput && isUserInputMode
      ? derivePendingUserInputProgress(
          pendingUserInput.questions,
          userInputAnswers,
          userInputQuestionIndex,
        )
      : null;
  const activeQuestion = userInputProgress?.activeQuestion;
  const userInputUsesComposer =
    isUserInputMode &&
    ((activeQuestion?.options.length ?? 0) === 0 || userInputProgress?.usingCustomAnswer);
  const showPromptEditor = !isApprovalMode && (!isUserInputMode || userInputUsesComposer);
  const canSendUserInput =
    isUserInputMode &&
    userInputUsesComposer &&
    value.trim().length > 0 &&
    !disabled &&
    !stateDependentActionsDisabled &&
    !isRespondingToUserInput;
  const canSendPrompt =
    !isApprovalMode &&
    !isUserInputMode &&
    value.trim().length > 0 &&
    !disabled &&
    !stateDependentActionsDisabled &&
    !isRunning &&
    deliveryState !== "pending" &&
    deliveryState !== "reconciling" &&
    deliveryState !== "uncertain";
  const canAdvanceUserInput =
    isUserInputMode &&
    (activeQuestion?.options.length ?? 0) > 0 &&
    !userInputUsesComposer &&
    Boolean(userInputProgress?.canAdvance) &&
    !stateDependentActionsDisabled &&
    !isRespondingToUserInput;

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      shouldHandleMobileComposerEnter({
        isComposing: event.nativeEvent.isComposing,
        key: event.key,
        shiftKey: event.shiftKey,
      })
    ) {
      event.preventDefault();
      if (canSendPrompt || canSendUserInput) {
        onSend();
      } else if (canAdvanceUserInput) {
        onAdvanceUserInput?.();
      }
    }
  }

  function handlePrimaryAction() {
    if (isRunning) {
      onStop?.();
      return;
    }
    if (canAdvanceUserInput) {
      onAdvanceUserInput?.();
      return;
    }
    if (canSendPrompt || canSendUserInput) {
      onSend();
    }
  }

  const composerDisabled =
    disabled || (isApprovalMode && !onRespondToApproval) || isRespondingToUserInput;
  const composerPlaceholder = isApprovalMode
    ? "Resolve this approval request to continue"
    : isUserInputMode
      ? userInputUsesComposer
        ? "Type your answer to continue..."
        : "Select an option above or type a custom answer"
      : isRunning
        ? (workingVerb ?? "Waiting for response…")
        : placeholder;
  const deliveryMessage =
    deliveryState === "pending"
      ? "Checking message delivery…"
      : deliveryState === "reconciling"
        ? "Checking whether your message was accepted…"
        : deliveryState === "uncertain"
          ? "Delivery is uncertain. Review the conversation before retrying."
          : deliveryState === "rejected"
            ? "Message was rejected. Your draft is still here."
            : null;
  const deliveryNoticeIsInline = deliveryState === "uncertain" || deliveryState === "reconciling";

  return (
    <div
      data-mobile-composer="true"
      className={cn(
        "min-h-0 shrink-0 bg-background",
        "pb-[max(0.75rem,env(safe-area-inset-bottom))]",
      )}
    >
      <div className="mx-auto w-full max-w-3xl px-3 py-2">
        <MobileComposerDeliveryNotice
          deliveryState={deliveryState}
          {...(onCheckDelivery ? { onCheckDelivery } : {})}
          storageWarning={storageWarning}
        />
        <div className={cn(composerSurfaceStyles.frame, "rounded-[22px]")}>
          <div
            className={cn(
              composerSurfaceStyles.surface,
              composerSurfaceStyles.surfaceFocus,
              "rounded-[20px] flex min-h-0 max-h-[min(52dvh,26rem)] flex-col overflow-hidden",
            )}
            data-mobile-composer-surface="true"
          >
            {pendingApproval ? (
              <MobileComposerApproval
                approval={pendingApproval}
                isLearningSkillProposal={isLearningSkillProposal}
              />
            ) : null}

            {pendingUserInput && onToggleUserInputOption && onAdvanceUserInput ? (
              <MobileComposerPendingUserInput
                answers={userInputAnswers}
                disabled={stateDependentActionsDisabled}
                isResponding={isRespondingToUserInput}
                onToggleOption={onToggleUserInputOption}
                pendingUserInput={pendingUserInput}
                questionIndex={userInputQuestionIndex}
              />
            ) : null}

            {showPromptEditor ? (
              <div
                className={cn(
                  composerSurfaceStyles.input.shell,
                  composerSurfaceStyles.input.compact,
                  "min-h-0 shrink-0",
                )}
              >
                <textarea
                  ref={textareaRef}
                  className="max-h-40 min-h-12 w-full resize-none overflow-y-auto bg-transparent text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground/70"
                  disabled={composerDisabled}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    onChange(nextValue);
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder={composerPlaceholder}
                  rows={2}
                  value={value}
                />
              </div>
            ) : null}

            <div className={cn(composerSurfaceStyles.footer.compact, "shrink-0")}>
              <div className={composerSurfaceStyles.footerLeading}>
                {modelSelection && onModelSelectionChange ? (
                  <MobileComposerModelPicker
                    lockedProvider={lockedProvider}
                    onChange={onModelSelectionChange}
                    {...(onProviderUnlock ? { onProviderUnlock } : {})}
                    providers={availableProviders}
                    selection={modelSelection}
                  />
                ) : null}
              </div>

              {isApprovalMode && pendingApproval && onRespondToApproval ? (
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                  <Button
                    className="min-h-11 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled={disabled || stateDependentActionsDisabled}
                    onClick={() => onRespondToApproval(pendingApproval.requestId, "decline")}
                    size="sm"
                    variant="outline"
                  >
                    {isLearningSkillProposal ? "Reject patch" : "Deny"}
                  </Button>
                  <Button
                    className="min-h-11"
                    disabled={disabled || stateDependentActionsDisabled}
                    onClick={() => onRespondToApproval(pendingApproval.requestId, "accept")}
                    size="sm"
                  >
                    {isLearningSkillProposal ? "Approve patch" : "Approve"}
                  </Button>
                </div>
              ) : (
                <div className="flex shrink-0 items-center gap-1.5">
                  {isUserInputMode &&
                  userInputProgress &&
                  userInputProgress.questionIndex > 0 &&
                  onPreviousUserInputQuestion ? (
                    <button
                      aria-label="Previous question"
                      className="inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-border text-foreground transition-colors active:bg-accent"
                      disabled={isRespondingToUserInput}
                      onClick={onPreviousUserInputQuestion}
                      type="button"
                    >
                      <ChevronLeftIcon className="size-3.5" />
                    </button>
                  ) : null}

                  {isRunning ? (
                    <button
                      aria-label="Stop generation"
                      className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full bg-rose-500/90 text-white transition-all duration-150 hover:scale-105 hover:bg-rose-500"
                      onClick={handlePrimaryAction}
                      type="button"
                    >
                      <MobileComposerStopIcon />
                    </button>
                  ) : isUserInputMode && canAdvanceUserInput ? (
                    <button
                      className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full bg-primary px-3 text-sm text-primary-foreground transition-colors"
                      disabled={!canAdvanceUserInput}
                      onClick={handlePrimaryAction}
                      type="button"
                    >
                      {userInputProgress?.isLastQuestion ? "Submit" : "Next"}
                    </button>
                  ) : (
                    <button
                      aria-label="Send message"
                      className={cn(
                        "inline-flex size-11 shrink-0 items-center justify-center rounded-full transition-colors",
                        canSendPrompt || canSendUserInput
                          ? "bg-primary/90 text-primary-foreground hover:scale-105 hover:bg-primary"
                          : "bg-muted text-muted-foreground opacity-30",
                      )}
                      disabled={!canSendPrompt && !canSendUserInput}
                      onClick={handlePrimaryAction}
                      type="button"
                    >
                      <MobileComposerSendIcon />
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        {projectTitle ? (
          <MobileComposerContextBar
            activeThreadBranch={activeThreadBranch}
            activeWorktreePath={activeWorktreePath}
            currentGitBranch={currentGitBranch}
            isGitRepo={isGitRepo}
            projectTitle={projectTitle}
          />
        ) : null}
        {deliveryMessage && !deliveryNoticeIsInline ? (
          <p className="px-1 pt-1 text-xs text-muted-foreground" role="status">
            {deliveryMessage}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function resolveMobileUserInputAnswers(
  pendingUserInput: MobilePendingUserInput,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
) {
  return buildPendingUserInputAnswers(pendingUserInput.questions, draftAnswers);
}

export function applyMobileUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
) {
  return setPendingUserInputCustomAnswer(draft, customAnswer);
}
