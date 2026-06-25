import type { UserInputQuestion } from "@bigbud/contracts";
import { CheckIcon } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
  togglePendingUserInputOptionSelection,
} from "~/logic/user-input";

import type { MobilePendingUserInput } from "../../mobileModels";
import { cn } from "../../lib/cn";

interface MobileComposerPendingUserInputProps {
  pendingUserInput: MobilePendingUserInput;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  isResponding: boolean;
  onToggleOption: (questionId: string, optionLabel: string) => void;
  onAdvance: () => void;
}

export function MobileComposerPendingUserInput({
  pendingUserInput,
  answers,
  questionIndex,
  isResponding,
  onToggleOption,
  onAdvance,
}: MobileComposerPendingUserInputProps) {
  const progress = derivePendingUserInputProgress(
    pendingUserInput.questions,
    answers,
    questionIndex,
  );
  const activeQuestion = progress.activeQuestion;
  const autoAdvanceTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
    };
  }, []);

  const handleOptionSelection = useCallback(
    (questionId: string, optionLabel: string) => {
      onToggleOption(questionId, optionLabel);
      if (activeQuestion?.multiSelect) {
        return;
      }
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
      autoAdvanceTimerRef.current = window.setTimeout(() => {
        autoAdvanceTimerRef.current = null;
        onAdvance();
      }, 200);
    },
    [activeQuestion?.multiSelect, onAdvance, onToggleOption],
  );

  if (!activeQuestion) {
    return null;
  }

  if (activeQuestion.options.length === 0) {
    return (
      <div className="border-b border-border/60 px-3 py-3">
        <p className="text-[11px] font-semibold tracking-widest text-muted-foreground/60 uppercase">
          Input required
        </p>
        <p className="mt-1.5 text-sm text-foreground/90">{activeQuestion.question}</p>
        <p className="mt-2 text-xs text-muted-foreground">Type your answer below and send.</p>
      </div>
    );
  }

  return (
    <div className="border-b border-border/60 px-3 py-3">
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
      <p className="mt-1.5 text-sm text-foreground/90">{activeQuestion.question}</p>
      {activeQuestion.multiSelect ? (
        <p className="mt-1 text-xs text-muted-foreground/65">Select one or more options.</p>
      ) : null}
      <OptionList
        activeQuestion={activeQuestion}
        isResponding={isResponding}
        progress={progress}
        onSelect={handleOptionSelection}
      />
    </div>
  );
}

function OptionList({
  activeQuestion,
  isResponding,
  progress,
  onSelect,
}: {
  activeQuestion: UserInputQuestion;
  isResponding: boolean;
  progress: ReturnType<typeof derivePendingUserInputProgress>;
  onSelect: (questionId: string, optionLabel: string) => void;
}) {
  return (
    <div className="mt-3 space-y-1">
      {activeQuestion.options.map((option, index) => {
        const isSelected = progress.selectedOptionLabels.includes(option.label);
        const shortcutKey = index < 9 ? index + 1 : null;
        return (
          <button
            key={`${activeQuestion.id}:${option.label}`}
            className={cn(
              "group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all duration-150",
              isSelected
                ? "border-info/40 bg-info/8 text-foreground"
                : "border-transparent bg-muted/20 text-foreground/80 hover:border-border/40 hover:bg-muted/40",
              isResponding && "cursor-not-allowed opacity-50",
            )}
            disabled={isResponding}
            onClick={() => onSelect(activeQuestion.id, option.label)}
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
  optionLabel: string,
): PendingUserInputDraftAnswer {
  return togglePendingUserInputOptionSelection(question, draft, optionLabel);
}
