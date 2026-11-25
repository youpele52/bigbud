import { resolvePlanFollowUpSubmission } from "../../../logic/proposed-plan";
import type { UseOnSendInput } from "./ChatView.sendTurn.types";

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
  const accepted = await input.onSubmitPlanFollowUp({
    text: followUp.text,
    interactionMode: followUp.interactionMode,
  });
  if (accepted) input.resetComposerDraft();
}
