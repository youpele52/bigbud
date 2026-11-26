import { useState } from "react";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";

import { useComposerDraftStore } from "../../../../stores/composer/composer.store";
import { usePendingUserInputHandlers } from "../ChatView.composerHandlers.logic";
import { createSendControl, useSendHarnessInput } from "../ChatView.sendTurn.browser-helpers";
import { useOnSend } from "../ChatView.sendTurn.logic";
import type { UseOnSendInput } from "../ChatView.sendTurn.types";

import type { PendingUserInput } from "../../../../logic/session/session.logic";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  togglePendingUserInputOptionSelection,
  withPendingUserInputDraftAnswer,
  type PendingUserInputDraftAnswer,
} from "../../../../logic/user-input/pending.logic";
import { PendingUserInputPanel } from "./PendingUserInputPanel";

export type PendingDrafts = Record<string, Record<string, PendingUserInputDraftAnswer>>;

/** Real draft state and progress derivation around the real panel, without the full ChatView. */
export function usePendingQuestionState(input: PendingUserInput | null) {
  const [drafts, setDrafts] = useState<PendingDrafts>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const requestDrafts = input ? (drafts[input.requestId] ?? {}) : {};
  const progress = input
    ? derivePendingUserInputProgress(input.questions, requestDrafts, questionIndex)
    : null;
  return {
    drafts,
    setDrafts,
    requestDrafts,
    progress,
    questionIndex,
    setQuestionIndex,
    toggleOption: (
      questionId: string,
      option: PendingUserInput["questions"][number]["options"][number],
      optionIndex: number,
    ) => {
      const question = input?.questions.find((entry) => entry.id === questionId);
      if (!input || !question) return;
      setDrafts((existing) =>
        withPendingUserInputDraftAnswer(
          existing,
          input.requestId,
          questionId,
          togglePendingUserInputOptionSelection(
            question,
            existing[input.requestId]?.[questionId],
            option,
            optionIndex,
          ),
        ),
      );
    },
  };
}

export function PendingQuestionHarness({
  input,
  compact = false,
}: {
  input: PendingUserInput;
  compact?: boolean;
}) {
  const state = usePendingQuestionState(input);
  if (!state.progress) return null;
  return (
    <PendingUserInputPanel
      pendingUserInput={input}
      progress={state.progress}
      compact={compact}
      onToggleOption={state.toggleOption}
      onSelectQuestion={state.setQuestionIndex}
    />
  );
}

/** Real question draft handlers, panel, and chat send in one form. */
export function PendingAnswerFlowHarness({
  threadId,
  input,
  control,
  overrides,
  onRespond,
}: {
  threadId: ThreadId;
  input: PendingUserInput;
  control: ReturnType<typeof createSendControl>;
  overrides: Partial<UseOnSendInput>;
  onRespond: (requestId: string, answers: Record<string, unknown>) => void;
}) {
  const [drafts, setDrafts] = useState<PendingDrafts>({});
  const [indexes, setIndexes] = useState<Record<string, number>>({});
  const requestDrafts = drafts[input.requestId] ?? {};
  const progress = derivePendingUserInputProgress(
    input.questions,
    requestDrafts,
    indexes[input.requestId] ?? 0,
  );
  const answers = buildPendingUserInputAnswers(input.questions, requestDrafts);
  const prompt = useComposerDraftStore((state) => state.draftsByThreadId[threadId]?.prompt ?? "");
  const sendInput = useSendHarnessInput({
    threadId,
    control,
    overrides: { hasPendingProviderRequest: true, ...overrides },
  });
  const handlers = usePendingUserInputHandlers({
    activePendingUserInput: input,
    activePendingProgress: progress,
    setPendingUserInputAnswersByRequestId: setDrafts,
    setPendingUserInputQuestionIndexByRequestId: setIndexes,
  });
  const onSend = useOnSend(sendInput);
  control.onSend = onSend;
  return (
    <form onSubmit={onSend}>
      <PendingUserInputPanel
        pendingUserInput={input}
        progress={progress}
        onToggleOption={handlers.onToggleActivePendingUserInputOption}
        onSelectQuestion={handlers.setActivePendingUserInputQuestionIndex}
        onChangeCustomAnswer={handlers.onChangeActivePendingUserInputCustomAnswer}
        canSubmit={answers !== null}
        onSubmit={() => {
          if (answers) onRespond(input.requestId, answers);
        }}
      />
      <textarea
        aria-label="Message"
        value={prompt}
        onChange={(event) => {
          sendInput.promptRef.current = event.target.value;
          useComposerDraftStore.getState().setPrompt(threadId, event.target.value);
        }}
      />
      <button type="submit">Queue message</button>
    </form>
  );
}
