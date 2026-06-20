/** Session reasons that indicate provider-side agent work is still in progress. */
const ONGOING_AGENT_WORK_SESSION_REASONS = new Set([
  "agent_start",
  "assistant_message.pending_completion",
  "turn.completed.awaiting_agent_end",
  "turn.queued",
]);

export function isOngoingAgentWorkSessionReason(reason: string | null | undefined): boolean {
  return reason != null && ONGOING_AGENT_WORK_SESSION_REASONS.has(reason);
}

export function isStaleRunningSessionUpdate(input: {
  readonly incomingStatus: string;
  readonly incomingActiveTurnId: string | null;
  readonly incomingReason: string | null | undefined;
  readonly latestTurn: {
    readonly turnId: string;
    readonly completedAt: string | null;
  } | null;
  readonly hasNonStreamingAssistantMessageForTurn: boolean;
}): boolean {
  if (input.incomingStatus !== "running" || input.incomingActiveTurnId === null) {
    return false;
  }
  if (input.latestTurn === null || input.latestTurn.turnId !== input.incomingActiveTurnId) {
    return false;
  }
  if (isOngoingAgentWorkSessionReason(input.incomingReason)) {
    return false;
  }
  return input.latestTurn.completedAt !== null || input.hasNonStreamingAssistantMessageForTurn;
}
