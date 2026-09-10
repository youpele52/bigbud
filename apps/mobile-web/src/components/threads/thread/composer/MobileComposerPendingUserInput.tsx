import type { UserInputQuestion } from "@bigbud/contracts";
import { CheckIcon } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import {
  derivePendingUserInputProgress,
  getPendingUserInputOptionIdentity,
  isPendingUserInputOptionSelected,
  type PendingUserInputDraftAnswer,
  togglePendingUserInputOptionSelection,
} from "~/logic/user-input";

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

  if (activeQuestion.options.length === 0) {
    return (
      <div
        aria-labelledby={questionLabelId}
        className="max-h-56 overflow-y-auto border-b border-border/60 px-3 py-3"
        role="group"
      >
        <p className="text-[11px] font-semibold tracking-widest text-muted-foreground/60 uppercase">
          Input required
        </p>
        <p
          ref={questionHeadingRef}
          aria-live="polite"
          className="mt-1.5 max-h-24 overflow-y-auto text-sm text-foreground/90 outline-none"
          id={questionLabelId}
          tabIndex={-1}
        >
          <span className="sr-only">
            Question {questionIndex + 1} of {pendingUserInput.questions.length}:{" "}
          </span>
          {activeQuestion.question}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">Type your answer below and send.</p>
      </div>
    );
  }

  return (
    <div
      aria-labelledby={questionLabelId}
      className="max-h-56 overflow-y-auto border-b border-border/60 px-3 py-3"
      role="group"
    >
      <div className="flex items-center gap-2">
        {pendingUserInput.questions.length > 1 ? (
          <span className="flex h-5 items-center rounded-md bg-muted/60 px-1.5 text-[10px] font-medium text-muted-foreground/60 tabular-nums">
            {questionIndex + 1}/{pendingUserInput.questions.length}
          </span>
        ) : null}
        <span className="text-[11px] font-semibold tracking-widest text-muted-foreground/60 uppercase">
          {activeQuestion.header}
        </span>
      </div>
      <p
        ref={questionHeadingRef}
        aria-live="polite"
        className="mt-1.5 max-h-24 overflow-y-auto text-sm text-foreground/90 outline-none"
        id={questionLabelId}
        tabIndex={-1}
      >
        <span className="sr-only">
          Question {questionIndex + 1} of {pendingUserInput.questions.length}:{" "}
        </span>
        {activeQuestion.question}
      </p>
      {activeQuestion.multiSelect ? (
        <p className="mt-1 text-xs text-muted-foreground/65">Select one or more options.</p>
      ) : null}
      <OptionList
        activeQuestion={activeQuestion}
        disabled={disabled}
        isResponding={isResponding}
        progress={progress}
        onSelect={handleOptionSelection}
      />
    </div>
  );
}

function OptionList({
  activeQuestion,
  disabled,
  isResponding,
  progress,
  onSelect,
}: {
  activeQuestion: UserInputQuestion;
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
          <button
            key={`${activeQuestion.id}:${getPendingUserInputOptionIdentity(option, index)}`}
            className={cn(
              "group flex min-h-11 w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all duration-150",
              isSelected
                ? "border-info/40 bg-info/8 text-foreground"
                : "border-transparent bg-muted/20 text-foreground/80 hover:border-border/40 hover:bg-muted/40",
              isResponding && "cursor-not-allowed opacity-50",
            )}
            aria-checked={isSelected}
            disabled={disabled || isResponding}
            onClick={() => onSelect(activeQuestion.id, option, index)}
            role={activeQuestion.multiSelect ? "checkbox" : "radio"}
            type="button"
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
              <span className="text-sm font-medium">{option.label}</span>
              {option.description && option.description !== option.label ? (
                <span className="ml-2 text-xs text-muted-foreground/50">{option.description}</span>
              ) : null}
            </div>
            {isSelected ? <CheckIcon className="size-3.5 shrink-0 text-info-foreground" /> : null}
          </button>
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
