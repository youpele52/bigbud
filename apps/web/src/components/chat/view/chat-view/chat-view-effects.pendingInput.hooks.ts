import type { UserInputQuestion } from "@bigbud/contracts/orchestration/providerRuntime.payloads.ts";
import { useEffect, useRef } from "react";

import {
  setPendingUserInputCustomAnswer,
  withPendingUserInputDraftAnswer,
} from "../../../../logic/user-input/pending.logic";
import type { ChatViewBaseState } from "./chat-view-base-state.hooks";
import type { ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";

interface VisitedQuestion {
  readonly requestId: string;
  readonly question: UserInputQuestion;
}

/**
 * One editor serves every question of a request. Moving between questions saves the editor text
 * into the question being left and loads the next question's text. A newly arriving question never
 * replaces an unsent draft: that draft is copied in as the first question's context.
 */
export function usePendingUserInputComposerSync(
  base: ChatViewBaseState,
  thread: ChatViewThreadDerivedState,
) {
  const {
    collapseExpandedComposerCursor,
    detectComposerTrigger,
    promptRef,
    setComposerCursor,
    setComposerHighlightedItemId,
    setComposerTrigger,
    setPendingUserInputAnswersByRequestId,
    setPrompt,
  } = base;
  const requestId = thread.activePendingUserInput?.requestId ?? null;
  const question = thread.activePendingProgress?.activeQuestion ?? null;
  const nextCustomAnswer = useRef("");
  nextCustomAnswer.current = thread.activePendingProgress?.customAnswer ?? "";
  const visited = useRef<VisitedQuestion | null>(null);

  useEffect(() => {
    const left = visited.current;
    visited.current = requestId && question ? { requestId, question } : null;
    if (!requestId || !question) return;
    if (left?.requestId !== requestId) {
      // An unsent draft becomes the arriving question's context, so Next/Submit reflect it.
      const draftText = promptRef.current;
      if (!draftText.trim()) return;
      setPendingUserInputAnswersByRequestId((existing) =>
        existing[requestId]?.[question.id]?.customAnswer
          ? existing
          : withPendingUserInputDraftAnswer(
              existing,
              requestId,
              question.id,
              setPendingUserInputCustomAnswer(existing[requestId]?.[question.id], draftText),
            ),
      );
      return;
    }
    if (left.question.id === question.id) return;
    const leavingText = promptRef.current;
    setPendingUserInputAnswersByRequestId((existing) =>
      withPendingUserInputDraftAnswer(
        existing,
        requestId,
        left.question.id,
        setPendingUserInputCustomAnswer(
          existing[requestId]?.[left.question.id],
          leavingText,
          left.question,
        ),
      ),
    );
    const next = nextCustomAnswer.current;
    promptRef.current = next;
    setPrompt(next);
    setComposerCursor(collapseExpandedComposerCursor(next, next.length));
    setComposerTrigger(detectComposerTrigger(next, next.length));
    setComposerHighlightedItemId(null);
  }, [
    collapseExpandedComposerCursor,
    detectComposerTrigger,
    promptRef,
    question,
    requestId,
    setComposerCursor,
    setComposerHighlightedItemId,
    setComposerTrigger,
    setPendingUserInputAnswersByRequestId,
    setPrompt,
  ]);
}
