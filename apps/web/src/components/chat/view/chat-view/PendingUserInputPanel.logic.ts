import type { UserInputQuestion } from "@bigbud/contracts/orchestration/providerRuntime.payloads.ts";
import {
  pendingUserInputAcceptsContext,
  singleChoiceQuestionAsksForMultiple,
} from "@bigbud/shared/providerUserInput";
import {
  describePendingUserInputQuestion,
  pendingUserInputComposerHint,
} from "@bigbud/ui/pendingUserInputPresentation";

import {
  getPendingUserInputOptionIdentity,
  isPendingUserInputOptionSelected,
  type PendingUserInputProgress,
} from "../../../../logic/user-input/pending.logic";

export interface PendingUserInputPanelOption {
  readonly key: string;
  readonly option: UserInputQuestion["options"][number];
  readonly optionIndex: number;
  readonly selected: boolean;
}

export interface PendingUserInputPanelModel {
  readonly question: UserInputQuestion;
  readonly questionIndex: number;
  /** "2 of 4" for multi-question requests; null when there is only one question. */
  readonly counterLabel: string | null;
  /**
   * Citable text matches answered history (UserInputQuestions) character for character, so a
   * citation taken while pending still anchors after the question is answered.
   */
  readonly title: string;
  readonly detail: string | null;
  readonly multiple: boolean;
  readonly options: ReadonlyArray<PendingUserInputPanelOption>;
  readonly canGoPrevious: boolean;
  readonly canGoNext: boolean;
  /** One line on what the composer adds; null when the question cannot take extra context. */
  readonly hint: string | null;
  /** Typed text that this question cannot carry alongside the chosen option. */
  readonly textIgnored: boolean;
}

/** Composer placeholder while a question is pending; only promises context where it is sent. */
export function pendingUserInputComposerPlaceholder(
  question: UserInputQuestion | null | undefined,
): string {
  return !question || question.options.length === 0 || pendingUserInputAcceptsContext(question)
    ? "Add context, or just send your selection"
    : "Pick an option, or type an answer instead";
}

function composerHint(question: UserInputQuestion): string | null {
  return pendingUserInputComposerHint({
    hasOptions: question.options.length > 0,
    acceptsContext: pendingUserInputAcceptsContext(question),
    singleChoiceAsksForMultiple: singleChoiceQuestionAsksForMultiple(question),
  });
}

export function derivePendingUserInputPanelModel(input: {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly progress: PendingUserInputProgress;
}): PendingUserInputPanelModel | null {
  const question = input.progress.activeQuestion;
  if (!question) return null;
  const count = input.questions.length;
  const index = input.progress.questionIndex;
  const presentation = describePendingUserInputQuestion({
    header: question.header,
    question: question.question,
    questionCount: count,
    questionIndex: index,
  });
  return {
    question,
    questionIndex: index,
    ...presentation,
    multiple: Boolean(question.multiSelect) || question.field?.type === "multiselect",
    options: question.options.map((option, optionIndex) => ({
      key: getPendingUserInputOptionIdentity(option, optionIndex),
      option,
      optionIndex,
      selected: isPendingUserInputOptionSelected(
        question,
        input.progress.activeDraft,
        option,
        optionIndex,
      ),
    })),
    canGoPrevious: index > 0,
    canGoNext: index < count - 1,
    hint: composerHint(question),
    // Custom-allowed multiselect fields send typed text as JSON entries, so it is not dropped.
    textIgnored:
      !pendingUserInputAcceptsContext(question) &&
      !(question.field?.type === "multiselect" && question.field.allowCustom) &&
      input.progress.customAnswer.trim().length > 0 &&
      input.progress.selectedOptionKeys.length > 0,
  };
}

/** Next/Submit state for the composer's primary action; present whenever a question is pending. */
export function derivePendingComposerAction(input: {
  readonly progress: PendingUserInputProgress | null;
  readonly isResponding: boolean;
  readonly resolvedAnswers: Readonly<Record<string, unknown>> | null;
}) {
  if (!input.progress) return null;
  return {
    questionIndex: input.progress.questionIndex,
    isLastQuestion: input.progress.isLastQuestion,
    canAdvance: input.progress.canAdvance,
    isResponding: input.isResponding,
    isComplete: input.resolvedAnswers !== null,
  };
}
