import type { OrchestrationThreadActivity } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { HTML_RENDER_ACTIVITY_KIND } from "@bigbud/contracts/orchestration/htmlRender.ts";

/** Durable visual replies share message-window retention with answered questions. */
export function isTranscriptHistoryActivity(activity: OrchestrationThreadActivity): boolean {
  return activity.kind === HTML_RENDER_ACTIVITY_KIND || isUserInputHistoryActivity(activity);
}

export function isUserInputHistoryActivity(activity: OrchestrationThreadActivity): boolean {
  return (
    activity.kind === "user-input.requested" ||
    activity.kind === "user-input.resolved" ||
    activity.kind === "provider.user-input.respond.failed"
  );
}

/** Work-log churn must not evict questions and answers belonging to the loaded chat history. */
export function retainUserInputHistoryActivities(
  orderedActivities: OrchestrationThreadActivity[],
  workLogLimit: number,
): OrchestrationThreadActivity[] {
  const cutoff = orderedActivities.length - workLogLimit;
  return orderedActivities.filter(
    (activity, index) => index >= cutoff || isTranscriptHistoryActivity(activity),
  );
}
