import type { Dispatch, SetStateAction } from "react";

import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "~/logic/user-input";
import type { derivePendingUserInputs } from "../lib/mobileModels";

type PendingUserInput = ReturnType<typeof derivePendingUserInputs>[number];
type AnswersByRequestId = Record<string, Record<string, PendingUserInputDraftAnswer>>;
type QuestionIndexByRequestId = Record<string, number>;

export function createMobileUserInputHandlers(input: {
  readonly activeAnswers: Record<string, PendingUserInputDraftAnswer>;
  readonly activePendingUserInput: PendingUserInput | null;
  readonly activeQuestionIndex: number;
  readonly sendPrompt: () => Promise<void>;
  readonly setAnswersByRequestId: Dispatch<SetStateAction<AnswersByRequestId>>;
  readonly setPrompt: Dispatch<SetStateAction<string>>;
  readonly setQuestionIndexByRequestId: Dispatch<SetStateAction<QuestionIndexByRequestId>>;
}) {
  const toggleOption = (questionId: string, optionLabel: string) => {
    const request = input.activePendingUserInput;
    if (!request) return;
    const question = request.questions.find((entry) => entry.id === questionId);
    if (!question) return;
    input.setAnswersByRequestId((existing) => ({
      ...existing,
      [request.requestId]: {
        ...existing[request.requestId],
        [questionId]: togglePendingUserInputOptionSelection(
          question,
          existing[request.requestId]?.[questionId],
          optionLabel,
        ),
      },
    }));
    input.setPrompt("");
  };

  const changeCustomAnswer = (questionId: string, value: string) => {
    const request = input.activePendingUserInput;
    if (!request) return;
    input.setAnswersByRequestId((existing) => ({
      ...existing,
      [request.requestId]: {
        ...existing[request.requestId],
        [questionId]: setPendingUserInputCustomAnswer(
          existing[request.requestId]?.[questionId],
          value,
        ),
      },
    }));
  };

  const advance = () => {
    const request = input.activePendingUserInput;
    if (!request) return;
    const progress = derivePendingUserInputProgress(
      request.questions,
      input.activeAnswers,
      input.activeQuestionIndex,
    );
    if (progress.isLastQuestion) {
      void input.sendPrompt();
    } else if (progress.canAdvance) {
      input.setQuestionIndexByRequestId((existing) => ({
        ...existing,
        [request.requestId]: input.activeQuestionIndex + 1,
      }));
      input.setPrompt("");
    }
  };

  const previous = () => {
    const request = input.activePendingUserInput;
    if (!request) return;
    input.setQuestionIndexByRequestId((existing) => ({
      ...existing,
      [request.requestId]: Math.max(input.activeQuestionIndex - 1, 0),
    }));
  };

  return { advance, changeCustomAnswer, previous, toggleOption } as const;
}
