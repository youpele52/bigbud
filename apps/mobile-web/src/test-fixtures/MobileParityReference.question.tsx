import type { UserInputQuestion } from "@bigbud/contracts";
import {
  derivePendingUserInputProgress,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@bigbud/shared/pendingUserInput";
import { useState } from "react";
import { PendingUserInputPanel } from "~/components/chat/view/chat-view/PendingUserInputPanel";
import { MobileComposerPendingUserInput } from "../components/threads/thread/composer/MobileComposerPendingUserInput";
import { parityQuestion } from "./MobileParityReference.data";

/** Actual consumer callbacks update fixture state; counters never enter production UI. */
export function MobileParityQuestion({ client }: { client: "desktop" | "mobile" }) {
  const variant =
    typeof location === "undefined"
      ? null
      : new URLSearchParams(location.search).get("choiceVariant");
  const first = parityQuestion.questions[0];
  if (!first) throw new Error("Question fixture must contain a choice question");
  const request =
    variant === "multiple"
      ? { ...parityQuestion, questions: [Object.assign({}, first, { multiSelect: true })] }
      : parityQuestion;
  const disabled = variant === "disabled";
  const [state, setState] = useState<{
    updates: number;
    answers: Record<string, PendingUserInputDraftAnswer>;
  }>({ updates: 0, answers: {} });
  const progress = derivePendingUserInputProgress(request.questions, state.answers, 0);
  const onToggle = (
    questionId: string,
    option: UserInputQuestion["options"][number],
    index: number,
  ) => {
    const question = request.questions.find((item) => item.id === questionId);
    if (!question) throw new Error("Unknown fixture question");
    setState((previous) => ({
      updates: previous.updates + 1,
      answers: {
        ...previous.answers,
        [questionId]: togglePendingUserInputOptionSelection(
          question,
          previous.answers[questionId],
          option,
          index,
        ),
      },
    }));
  };
  return (
    <div data-choice-updates={state.updates} data-choice-variant={variant ?? "single"}>
      {client === "desktop" ? (
        <PendingUserInputPanel
          compact
          pendingUserInput={request}
          progress={progress}
          disabled={disabled}
          onToggleOption={onToggle}
          onSelectQuestion={() => {}}
        />
      ) : (
        <MobileComposerPendingUserInput
          pendingUserInput={request}
          answers={state.answers}
          questionIndex={0}
          isResponding={false}
          disabled={disabled}
          onToggleOption={onToggle}
        />
      )}
    </div>
  );
}
