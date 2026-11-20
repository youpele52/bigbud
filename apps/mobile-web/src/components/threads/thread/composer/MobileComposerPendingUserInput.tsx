import type { UserInputQuestion } from "@bigbud/contracts";
import {
  pendingUserInputAcceptsContext,
  singleChoiceQuestionAsksForMultiple,
} from "@bigbud/shared/providerUserInput";
import {
  describePendingUserInputQuestion,
  pendingUserInputAttentionLabel,
  pendingUserInputComposerHint,
  pendingUserInputPresentationStyles,
} from "@bigbud/ui/pendingUserInputPresentation";
import { PendingUserInputChoice } from "@bigbud/ui/pendingUserInputChoice";
import { CheckIcon } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import {
  derivePendingUserInputProgress,
  getPendingUserInputOptionIdentity,
  isPendingUserInputOptionSelected,
  type PendingUserInputDraftAnswer,
  togglePendingUserInputOptionSelection,
} from "@bigbud/shared/pendingUserInput";

import type { MobilePendingUserInput } from "../../../../lib/mobileModels";
import { cn } from "../../../../lib/cn";

interface MobileComposerPendingUserInputProps {
  pendingUserInput: MobilePendingUserInput;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  isResponding: boolean;
  disabled?: boolean;
  onToggleOption: (
    questionId: string,
    option: UserInputQuestion["options"][number],
    optionIndex: number,
  ) => void;
}

export function MobileComposerPendingUserInput({
  pendingUserInput,
  answers,
  questionIndex,
  isResponding,
  disabled = false,
  onToggleOption,
}: MobileComposerPendingUserInputProps) {
  const progress = derivePendingUserInputProgress(
    pendingUserInput.questions,
    answers,
    questionIndex,
  );
  const activeQuestion = progress.activeQuestion;
  const questionHeadingRef = useRef<HTMLParagraphElement>(null);
  const handleOptionSelection = useCallback(
    (questionId: string, option: UserInputQuestion["options"][number], optionIndex: number) => {
      if (disabled) return;
      onToggleOption(questionId, option, optionIndex);
    },
    [disabled, onToggleOption],
  );

  useEffect(() => {
    questionHeadingRef.current?.focus();
  }, [activeQuestion?.id]);

  if (!activeQuestion) {
    return null;
  }

  const questionLabelId = `mobile-question-${encodeURIComponent(activeQuestion.id)}`;
  const presentation = describePendingUserInputQuestion({
    header: activeQuestion.header,
    question: activeQuestion.question,
    questionIndex: progress.questionIndex,
    questionCount: pendingUserInput.questions.length,
  });
  const hint = pendingUserInputComposerHint({
    hasOptions: activeQuestion.options.length > 0,
    acceptsContext: pendingUserInputAcceptsContext(activeQuestion),
    singleChoiceAsksForMultiple: singleChoiceQuestionAsksForMultiple(activeQuestion),
  });

  return (
    <div
      aria-labelledby={questionLabelId}
      className="max-h-64 overflow-y-auto border-b border-border/60 px-3 py-3"
      role="group"
    >
      <div className="mb-1.5 flex min-h-6 items-center gap-2">
        <span className="inline-flex h-5 items-center rounded-sm border border-input bg-background px-1 text-xs font-normal text-foreground">
          {pendingUserInputAttentionLabel}
        </span>
        {presentation.counterLabel ? (
          <span aria-live="polite" className="text-xs text-muted-foreground">
            {presentation.counterLabel}
          </span>
        ) : null}
      </div>
      <p
        ref={questionHeadingRef}
        aria-describedby={presentation.detail ? `${questionLabelId}-detail` : undefined}
        aria-live="polite"
        className={cn(pendingUserInputPresentationStyles.title, "outline-none")}
        id={questionLabelId}
        tabIndex={-1}
      >
        <span className="sr-only">
          Question {progress.questionIndex + 1} of {pendingUserInput.questions.length}:{" "}
        </span>
        {presentation.title}
      </p>
      {presentation.detail ? (
        <p id={`${questionLabelId}-detail`} className={pendingUserInputPresentationStyles.detail}>
          {presentation.detail}
        </p>
      ) : null}
      {activeQuestion.multiSelect ? (
        <p className="mt-1 text-xs text-muted-foreground/65">Select one or more options.</p>
      ) : null}
      {activeQuestion.options.length > 0 ? (
        <OptionList
          activeQuestion={activeQuestion}
          requestId={pendingUserInput.requestId}
          disabled={disabled}
          isResponding={isResponding}
          progress={progress}
          onSelect={handleOptionSelection}
        />
      ) : null}
      {hint ? <p className={pendingUserInputPresentationStyles.hint}>{hint}</p> : null}
    </div>
  );
}

function OptionList({
  activeQuestion,
  requestId,
  disabled,
  isResponding,
  progress,
  onSelect,
}: {
  activeQuestion: UserInputQuestion;
  requestId: MobilePendingUserInput["requestId"];
  disabled: boolean;
  isResponding: boolean;
  progress: ReturnType<typeof derivePendingUserInputProgress>;
  onSelect: (
    questionId: string,
    option: UserInputQuestion["options"][number],
    optionIndex: number,
  ) => void;
}) {
  return (
    <div
      aria-label={activeQuestion.question}
      className="mt-3 max-h-36 space-y-1 overflow-y-auto"
      role={activeQuestion.multiSelect ? "group" : "radiogroup"}
    >
      {activeQuestion.options.map((option, index) => {
        const isSelected = isPendingUserInputOptionSelected(
          activeQuestion,
          progress.activeDraft,
          option,
          index,
        );
        const shortcutKey = index < 9 ? index + 1 : null;
        return (
          <PendingUserInputChoice
            key={`${activeQuestion.id}:${getPendingUserInputOptionIdentity(option, index)}`}
            className={cn(
              "group relative flex min-h-11 w-full items-center gap-3 rounded-full border px-3 py-2 text-left transition-all duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
              isSelected
                ? "border-info/40 bg-info/8 text-foreground"
                : "border-input bg-background text-foreground hover:bg-accent/50",
              isResponding && "cursor-not-allowed opacity-50",
            )}
            checked={isSelected}
            name={`pending-${requestId}-${activeQuestion.id}`}
            disabled={disabled || isResponding}
            onToggle={() => onSelect(activeQuestion.id, option, index)}
            type={activeQuestion.multiSelect ? "checkbox" : "radio"}
          >
            {shortcutKey !== null ? (
              <kbd
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded text-[11px] font-medium tabular-nums transition-colors duration-150",
                  isSelected
                    ? "bg-info/20 text-info-foreground"
                    : "bg-muted/40 text-muted-foreground/50 group-hover:bg-muted/60 group-hover:text-muted-foreground/70",
                )}
              >
                {shortcutKey}
              </kbd>
            ) : null}
            <div className="min-w-0 flex-1">
              <span className="text-sm">{option.label}</span>
              {option.description && option.description !== option.label ? (
                <span className="ml-2 text-xs text-muted-foreground">{option.description}</span>
              ) : null}
            </div>
            {isSelected ? <CheckIcon className="size-3.5 shrink-0 text-info-foreground" /> : null}
          </PendingUserInputChoice>
        );
      })}
    </div>
  );
}

export function toggleMobileUserInputOption(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  option: UserInputQuestion["options"][number],
  optionIndex?: number,
): PendingUserInputDraftAnswer {
  return togglePendingUserInputOptionSelection(question, draft, option, optionIndex);
}
