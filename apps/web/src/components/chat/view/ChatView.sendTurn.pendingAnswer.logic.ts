import type { UserInputQuestion } from "@bigbud/contracts/orchestration/providerRuntime.payloads.ts";

import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
} from "../../../logic/user-input/pending.logic";

/**
 * The one answer map a pending send submits: per-question chips plus custom text. The composer
 * text is reconciled into the active question at send time so a keystroke that has not re-rendered
 * yet still counts. Requests without questions keep the legacy request-id keyed text answer.
 */
export function resolvePendingSubmissionAnswers(input: {
  readonly requestId: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly draftAnswers: Readonly<Record<string, PendingUserInputDraftAnswer>> | undefined;
  readonly activeQuestionId: string | null | undefined;
  readonly promptText: string;
}): Record<string, string | string[]> | null {
  if (input.questions.length === 0) {
    const text = input.promptText.trim();
    return text ? { [input.requestId]: text } : null;
  }
  const active =
    input.questions.find((question) => question.id === input.activeQuestionId) ??
    input.questions[0]!;
  const drafts = {
    ...input.draftAnswers,
    [active.id]: setPendingUserInputCustomAnswer(
      input.draftAnswers?.[active.id],
      input.promptText,
      active,
    ),
  };
  return buildPendingUserInputAnswers(input.questions, drafts);
}

/** Stable label so the agent ties the follow-up files to the answer it just received. */
export function buildPendingAttachmentFollowUpText(
  questions: ReadonlyArray<UserInputQuestion>,
  answers: Readonly<Record<string, unknown>>,
): string {
  const lines = questions
    .filter((question) => answers[question.id] !== undefined)
    .map(
      (question) =>
        `The attached files are part of my answer to: ${(question.header || question.question || question.id).trim()}`,
    );
  return lines.length > 0 ? lines.join("\n") : "The attached files are part of my answer.";
}
