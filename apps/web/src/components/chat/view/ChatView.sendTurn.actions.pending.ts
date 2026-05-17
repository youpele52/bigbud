import { resolvePlanFollowUpSubmission } from "../../../logic/proposed-plan";

import type { UseOnSendInput } from "./ChatView.sendTurn.types";

export async function respondToPendingUserInput(input: {
  activePendingUserInput: UseOnSendInput["activePendingUserInput"];
  activePendingUserInputRequestId: NonNullable<UseOnSendInput["activePendingUserInputRequestId"]>;
  onRespondToUserInput: UseOnSendInput["onRespondToUserInput"];
  resetComposerDraft: () => void;
  trimmed: string;
}) {
  if (!input.trimmed) {
    return;
  }

  const questions = input.activePendingUserInput?.questions ?? [];
  const answers: Record<string, string> =
    questions.length > 0
      ? Object.fromEntries(questions.map((question) => [question.id, input.trimmed]))
      : { [input.activePendingUserInputRequestId]: input.trimmed };
  await input.onRespondToUserInput(input.activePendingUserInputRequestId, answers);
  input.resetComposerDraft();
}

export async function submitPlanFollowUp(input: {
  proposedPlan: NonNullable<UseOnSendInput["activeProposedPlan"]>;
  onSubmitPlanFollowUp: UseOnSendInput["onSubmitPlanFollowUp"];
  resetComposerDraft: () => void;
  trimmed: string;
}) {
  const followUp = resolvePlanFollowUpSubmission({
    draftText: input.trimmed,
    planMarkdown: input.proposedPlan.planMarkdown,
  });
  input.resetComposerDraft();
  await input.onSubmitPlanFollowUp({
    text: followUp.text,
    interactionMode: followUp.interactionMode,
  });
}
