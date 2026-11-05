import type { QueueDecisionReason } from "@bigbud/contracts/orchestration/orchestration.queueDecision.ts";

export const queueDecisionMessages: Record<QueueDecisionReason, string> = {
  queue_busy: "The thread is working. Your prompts remain queued.",
  queue_pending_start: "The previous turn is still starting. Your prompts remain queued.",
  queue_waiting_for_user:
    "The thread is waiting for a response or model choice. Your prompts remain queued.",
  queue_held: "The queue is held. Use Send now to release it.",
  queue_reserved: "Another queue action is still in progress. Your prompts remain queued.",
  queue_stale_selection:
    "The selected queue has changed. Review the current queue before trying again.",
  queue_stale_turn:
    "The active turn or session has changed. Review the current queue before trying again.",
  queue_invalid_owner:
    "This queue action no longer owns the selected prompts. Review the current queue.",
  queue_incompatible_reservation:
    "The reserved prompts have incompatible settings. The queue was not sent.",
  queue_unavailable: "This thread is unavailable. The queue was not sent.",
};
