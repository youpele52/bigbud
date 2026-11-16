import type { UserInputQuestion } from "@bigbud/contracts/orchestration/providerRuntime.payloads.ts";
import {
  pendingUserInputAttentionLabel,
  pendingUserInputPresentationStyles,
} from "@bigbud/ui/pendingUserInputPresentation";
import { PendingUserInputChoice } from "@bigbud/ui/pendingUserInputChoice";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { cn } from "~/lib/utils";
import type { PendingUserInput } from "../../../../logic/session/session.logic";
import { visibleUserInputOptionDescription } from "../../../../logic/user-input/option.logic";
import type { PendingUserInputProgress } from "../../../../logic/user-input/pending.logic";
import { Badge } from "../../../ui/badge";
import { Button, buttonVariants } from "../../../ui/button";
import { useChatCitationActions } from "../../common/ChatCitation.context";
import { UserInputFieldHint } from "../../messages/UserInputFieldHint";
import { derivePendingUserInputPanelModel } from "./PendingUserInputPanel.logic";

interface PendingUserInputPanelProps {
  pendingUserInput: Pick<PendingUserInput, "requestId" | "questions">;
  progress: PendingUserInputProgress;
  compact?: boolean;
  disabled?: boolean;
  onToggleOption: (
    questionId: string,
    option: UserInputQuestion["options"][number],
    optionIndex: number,
  ) => void;
  onSelectQuestion: (questionIndex: number) => void;
}

/** Brings a cited pending question on screen, then lets the citation highlight run. */
function useQuestionCitationFocus(
  requestId: string,
  questions: PendingUserInputPanelProps["pendingUserInput"]["questions"],
  activeQuestionId: string | undefined,
  onSelectQuestion: (questionIndex: number) => void,
) {
  const actions = useChatCitationActions();
  const focus = actions?.questionFocus;
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (!actions || !focus || focus.requestId !== requestId || handled.current === focus.token)
      return;
    const index = questions.findIndex((question) => question.id === focus.questionId);
    if (index >= 0 && questions[index]!.id !== activeQuestionId) {
      onSelectQuestion(index);
      return;
    }
    handled.current = focus.token;
    actions.onQuestionFocused(focus.token);
  }, [actions, activeQuestionId, focus, onSelectQuestion, questions, requestId]);
}

/** A pending question docked above the composer; the composer itself is the free-text field. */
export function PendingUserInputPanel({
  pendingUserInput,
  progress,
  compact = false,
  disabled = false,
  onToggleOption,
  onSelectQuestion,
}: PendingUserInputPanelProps) {
  const { requestId, questions } = pendingUserInput;
  const model = useMemo(
    () => derivePendingUserInputPanelModel({ questions, progress }),
    [questions, progress],
  );
  useQuestionCitationFocus(requestId, questions, model?.question.id, onSelectQuestion);
  if (!model) return null;
  const { question } = model;
  return (
    <section
      data-chat-cite-scope
      data-pending-user-input-panel
      aria-label="Question from the agent"
      className={cn("min-w-0", compact ? "px-3 py-2" : "px-4 py-3")}
    >
      <div data-chat-cite-request-id={requestId}>
        <div className="mb-1.5 flex min-h-6 items-center gap-2">
          <Badge variant="outline" size="sm" className="text-xs font-normal">
            {pendingUserInputAttentionLabel}
          </Badge>
          {model.counterLabel ? (
            <>
              <span className="text-xs text-muted-foreground" aria-live="polite">
                {model.counterLabel}
              </span>
              <span className="ml-auto flex items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Previous question"
                  disabled={disabled || !model.canGoPrevious}
                  onClick={() => onSelectQuestion(model.questionIndex - 1)}
                >
                  <ChevronLeftIcon />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Next question"
                  disabled={disabled || !model.canGoNext}
                  onClick={() => onSelectQuestion(model.questionIndex + 1)}
                >
                  <ChevronRightIcon />
                </Button>
              </span>
            </>
          ) : null}
        </div>
        <div key={question.id} data-chat-cite-question-id={question.id}>
          <UserInputFieldHint question={question} />
          <div data-chat-cite-content data-chat-cite-region="prompt">
            <p data-chat-cite-region="header" className={pendingUserInputPresentationStyles.title}>
              {model.title}
            </p>
            {model.detail ? (
              <p
                data-chat-cite-region="question"
                className={pendingUserInputPresentationStyles.detail}
              >
                {model.detail}
              </p>
            ) : null}
            {model.options.length > 0 ? (
              <div
                data-chat-cite-region="options"
                role={model.multiple ? "group" : "radiogroup"}
                aria-label={model.title}
                className="mt-2 flex flex-wrap gap-1.5"
              >
                {model.options.map(({ key, option, optionIndex, selected }) => (
                  <PendingUserInputChoice
                    key={key}
                    type={model.multiple ? "checkbox" : "radio"}
                    name={`pending-${requestId}-${question.id}`}
                    checked={selected}
                    disabled={disabled}
                    onToggle={() => onToggleOption(question.id, option, optionIndex)}
                    className={cn(
                      buttonVariants({ variant: selected ? "default" : "outline", size: "sm" }),
                      "h-auto max-w-full select-text whitespace-normal rounded-full py-1 text-left text-sm sm:h-auto",
                      "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                      disabled && "pointer-events-none opacity-64",
                    )}
                  >
                    <span>{option.label}</span>
                    {visibleUserInputOptionDescription(option) ? (
                      <span className="text-xs font-normal opacity-75">
                        {" "}
                        — {visibleUserInputOptionDescription(option)}
                      </span>
                    ) : null}
                  </PendingUserInputChoice>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        {model.hint ? (
          <p className={pendingUserInputPresentationStyles.hint}>{model.hint}</p>
        ) : null}
        {model.textIgnored ? (
          <p role="status" className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            This question sends only the chosen option; your typed text will not be included.
          </p>
        ) : null}
      </div>
    </section>
  );
}
