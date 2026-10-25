import type { OrchestrationThreadActivity } from "@bigbud/contracts/orchestration/orchestration.thread.ts";

export const PROVIDER_TURN_FAILURE_NOTICE_KIND = "provider.turn.failure-notice";

/** Only failures from this backend run may open a run-scoped notice. */
export function firstProviderTurnFailure(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  serverRunId: string,
): string | null {
  for (const activity of activities) {
    if (activity.kind !== PROVIDER_TURN_FAILURE_NOTICE_KIND) continue;
    const payload = activity.payload;
    if (
      payload &&
      typeof payload === "object" &&
      "serverRunId" in payload &&
      payload.serverRunId === serverRunId &&
      "message" in payload &&
      typeof payload.message === "string"
    )
      return payload.message;
  }
  return null;
}
