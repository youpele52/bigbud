import type { QueueDecisionReason } from "@bigbud/contracts/orchestration/orchestration.queueDecision.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

import { queueDecisionMessages } from "@bigbud/shared/queueDecision";

export function queueDecisionError(reason: QueueDecisionReason) {
  return new OrchestrationCommandInvariantError({
    commandType: "thread.queued-prompt.flush",
    code: reason,
    detail: queueDecisionMessages[reason],
  });
}
