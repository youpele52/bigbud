import { resolvePlanFollowUpSubmission } from "../../../logic/proposed-plan";
import { toastManager } from "../../ui/toast";

import { buildTurnAttachments } from "./ChatView.sendTurn.helpers";
import {
  buildPendingAttachmentFollowUpText,
  resolvePendingSubmissionAnswers,
} from "./ChatView.sendTurn.pendingAnswer.logic";
import type { UseOnSendInput } from "./ChatView.sendTurn.types";

/**
 * The single path that resolves a pending question. Answer protocols carry text only, so composer
 * attachments follow as one labelled queued prompt, strictly after the answer resolves. The draft
 * is cleared only once both succeed; a refused follow-up keeps everything in the composer.
 */
export async function respondToPendingUserInput(input: {
  activePendingUserInput: UseOnSendInput["activePendingUserInput"];
  activePendingUserInputRequestId: NonNullable<UseOnSendInput["activePendingUserInputRequestId"]>;
  activePendingDraftAnswers: UseOnSendInput["activePendingDraftAnswers"];
  activeQuestionId: string | null | undefined;
  promptText: string;
  images: UseOnSendInput["composerImages"];
  files: UseOnSendInput["composerFiles"];
  onRespondToUserInput: UseOnSendInput["onRespondToUserInput"];
  submitQueuedComposerPrompt: UseOnSendInput["submitQueuedComposerPrompt"];
  resetComposerDraft: () => void;
}) {
  const questions = input.activePendingUserInput?.questions ?? [];
  const answers = resolvePendingSubmissionAnswers({
    requestId: input.activePendingUserInputRequestId,
    questions,
    draftAnswers: input.activePendingDraftAnswers,
    activeQuestionId: input.activeQuestionId,
    promptText: input.promptText,
  });
  if (!answers) return;
  await input.onRespondToUserInput(input.activePendingUserInputRequestId, answers);
  if (input.images.length > 0 || input.files.length > 0) {
    try {
      const attachments = await buildTurnAttachments(input.images, input.files);
      const result = await input.submitQueuedComposerPrompt({
        text: buildPendingAttachmentFollowUpText(questions, answers),
        attachments,
      });
      if (result !== "queued") {
        throw new Error(
          result === "full"
            ? "The prompt queue is full. Send or remove a queued prompt, then send the files."
            : "The attachments could not be prepared.",
        );
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Your answer was sent, but the attachments were not",
        description: `${error instanceof Error ? error.message : String(error)} They are still in the composer.`,
      });
      return;
    }
  }
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
  const accepted = await input.onSubmitPlanFollowUp({
    text: followUp.text,
    interactionMode: followUp.interactionMode,
  });
  if (accepted) input.resetComposerDraft();
}
