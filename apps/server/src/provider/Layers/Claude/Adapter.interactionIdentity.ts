import type { ApprovalRequestId } from "@bigbud/contracts";
import type { ClaudeSessionContext } from "./Adapter.types.ts";

import { interactionGeneration as claudeInteractionGeneration } from "../../pendingInteractionAdmission.ts";
export { claudeInteractionGeneration };

export function claudeInteractionPublication(
  context: ClaudeSessionContext,
  requestId: ApprovalRequestId,
) {
  const entry = context.requestLedger.get(requestId);
  if (entry?.state !== "resolving") return;
  const latch = entry.kind === "approval" ? entry.decision : entry.answers;
  return {
    generation: claudeInteractionGeneration(latch),
    completion: entry.completion,
    isStillBlocking: () =>
      (entry.kind === "approval"
        ? context.pendingApprovals.get(requestId)?.decision
        : context.pendingUserInputs.get(requestId)?.answers) === latch,
  };
}
