import { useState } from "react";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";

import {
  collapseExpandedComposerCursor,
  detectComposerTrigger,
} from "../../../../logic/composer/composer.logic";
import { useComposerDraftStore } from "../../../../stores/composer/composer.store";
import { ComposerPrimaryActions } from "../../composer/ComposerPrimaryActions";
import { usePendingUserInputHandlers } from "../ChatView.composerHandlers.logic";
import { createSendControl, useSendHarnessInput } from "../ChatView.sendTurn.browser-helpers";
import { useOnSend } from "../ChatView.sendTurn.logic";
import type { UseOnSendInput } from "../ChatView.sendTurn.types";
import type { ChatViewBaseState } from "./chat-view-base-state.hooks";
import { usePendingUserInputComposerSync } from "./chat-view-effects.pendingInput.hooks";
import type { ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";

import type { PendingUserInput } from "../../../../logic/session/session.logic";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  togglePendingUserInputOptionSelection,
  withPendingUserInputDraftAnswer,
  type PendingUserInputDraftAnswer,
} from "../../../../logic/user-input/pending.logic";
import { PendingUserInputPanel } from "./PendingUserInputPanel";
import { derivePendingComposerAction } from "./PendingUserInputPanel.logic";

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

const noop = () => {};

/**
 * Production answer flow without the full ChatView: real pending handlers, question-switch sync,
 * panel, primary Next/Submit action, send hook and stores. The textarea stands in for the editor
 * and mirrors text exactly as the composer's prompt-change handler does.
 */
export function PendingAnswerFlowHarness({
  threadId,
  input,
  control,
  overrides,
}: {
  threadId: ThreadId;
  input: PendingUserInput;
  control: ReturnType<typeof createSendControl>;
  overrides: Partial<UseOnSendInput>;
}) {
  const [drafts, setDrafts] = useState<PendingDrafts>({});
  const [indexes, setIndexes] = useState<Record<string, number>>({});
  const requestDrafts = drafts[input.requestId] ?? {};
  const progress = derivePendingUserInputProgress(
    input.questions,
    requestDrafts,
    indexes[input.requestId] ?? 0,
  );
  const prompt = useComposerDraftStore((state) => state.draftsByThreadId[threadId]?.prompt ?? "");
  const setPrompt = (text: string) => useComposerDraftStore.getState().setPrompt(threadId, text);
  const sendInput = useSendHarnessInput({
    threadId,
    control,
    overrides: {
      isOpencodePendingUserInputMode: true,
      activePendingUserInputRequestId: input.requestId,
      activePendingUserInput: input,
      activePendingProgress: progress,
      activePendingDraftAnswers: requestDrafts,
      ...overrides,
    },
  });
  const handlers = usePendingUserInputHandlers({
    activePendingUserInput: input,
    activePendingProgress: progress,
    setPendingUserInputAnswersByRequestId: setDrafts,
    setPendingUserInputQuestionIndexByRequestId: setIndexes,
  });
  sendInput.setActivePendingUserInputQuestionIndex =
    handlers.setActivePendingUserInputQuestionIndex;
  usePendingUserInputComposerSync(
    {
      collapseExpandedComposerCursor,
      detectComposerTrigger,
      promptRef: sendInput.promptRef,
      setComposerCursor: noop,
      setComposerHighlightedItemId: noop,
      setComposerTrigger: noop,
      setPendingUserInputAnswersByRequestId: setDrafts,
      setPrompt,
    } as unknown as ChatViewBaseState,
    {
      activePendingUserInput: input,
      activePendingProgress: progress,
    } as ChatViewThreadDerivedState,
  );
  const onSend = useOnSend(sendInput);
  control.onSend = onSend;
  return (
    <form onSubmit={onSend}>
      <PendingUserInputPanel
        pendingUserInput={input}
        progress={progress}
        onToggleOption={handlers.onToggleActivePendingUserInputOption}
        onSelectQuestion={handlers.setActivePendingUserInputQuestionIndex}
      />
      <textarea
        aria-label="Message"
        value={prompt}
        onChange={(event) => {
          sendInput.promptRef.current = event.target.value;
          setPrompt(event.target.value);
          if (progress.activeQuestion)
            handlers.onChangeActivePendingUserInputCustomAnswer(
              progress.activeQuestion.id,
              event.target.value,
            );
        }}
      />
      <ComposerPrimaryActions
        compact={false}
        pendingAction={derivePendingComposerAction({
          progress,
          isResponding: false,
          resolvedAnswers: buildPendingUserInputAnswers(input.questions, requestDrafts),
        })}
        isRunning={false}
        showPlanFollowUpPrompt={false}
        promptHasText={prompt.trim().length > 0}
        isSendBusy={false}
        isConnecting={false}
        isPreparingWorktree={false}
        hasSendableContent
        onPreviousPendingQuestion={handlers.onPreviousActivePendingUserInputQuestion}
        onInterrupt={noop}
        onImplementPlanInNewThread={noop}
      />
    </form>
  );
}
