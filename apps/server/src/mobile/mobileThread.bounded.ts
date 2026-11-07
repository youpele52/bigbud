import type {
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadActivity,
} from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import type {
  GetSelectedThreadDetailResult,
  ThreadDetailMessage,
} from "@bigbud/contracts/orchestration/orchestration.detail.ts";

function toOrchestrationMessage(message: ThreadDetailMessage): OrchestrationMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    attachments: message.attachments,
    ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
    ...(message.originSegments !== undefined ? { originSegments: message.originSegments } : {}),
    turnId: message.turnId,
    streaming: message.streaming,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

function compareActivities(left: OrchestrationThreadActivity, right: OrchestrationThreadActivity) {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  }
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

/**
 * The mobile thread view from bounded reads only: the operational shell (identity, session, latest
 * turn, tasks and watches) plus the selected-thread detail window (byte-bounded newest messages,
 * the active turn's activities, answered questions, the active plan and recent checkpoints).
 */
export function buildBoundedMobileThread(
  shell: OrchestrationThread,
  detail: GetSelectedThreadDetailResult,
): OrchestrationThread {
  const activities = new Map<string, OrchestrationThreadActivity>();
  for (const activity of [...shell.activities, ...detail.activities]) {
    activities.set(activity.id, activity);
  }
  const checkpoints: OrchestrationCheckpointSummary[] = detail.checkpoints
    .map((checkpoint) => ({ ...checkpoint, files: [] }))
    .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount);
  return {
    ...shell,
    messages: detail.messages.map(toOrchestrationMessage).toReversed(),
    activities: [...activities.values()].toSorted(compareActivities),
    proposedPlans: detail.activePlan === null ? [] : [detail.activePlan],
    checkpoints,
  };
}
