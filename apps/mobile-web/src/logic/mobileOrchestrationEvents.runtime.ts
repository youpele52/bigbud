import type { OrchestrationEvent, OrchestrationThread } from "@bigbud/contracts";
import { isStaleRunningSessionUpdate } from "~/stores/main/events.store.threads.runtime.logic";

export function applyMobileSession(
  thread: OrchestrationThread,
  event: Extract<OrchestrationEvent, { type: "thread.session-set" }>,
): OrchestrationThread | null {
  if (event.payload.threadId !== thread.id) {
    return null;
  }
  const sameEpoch =
    (thread.session?.sessionEpoch ?? 0) === (event.payload.session.sessionEpoch ?? 0);
  const incomingSession = event.payload.session;
  const incomingActiveTurnId = incomingSession.activeTurnId ?? null;
  const hasNonStreamingAssistantMessageForTurn =
    incomingActiveTurnId !== null &&
    thread.messages.some(
      (message) =>
        message.turnId === incomingActiveTurnId &&
        message.role === "assistant" &&
        message.streaming === false,
    );
  const isStaleRunningSession = isStaleRunningSessionUpdate({
    incomingStatus: incomingSession.status,
    incomingActiveTurnId,
    incomingReason: incomingSession.reason,
    latestTurn: sameEpoch ? thread.latestTurn : null,
    hasNonStreamingAssistantMessageForTurn,
  });
  const normalizedSession = isStaleRunningSession
    ? { ...incomingSession, status: "ready" as const, activeTurnId: null, reason: null }
    : incomingSession;
  return {
    ...thread,
    session: normalizedSession,
    latestTurn:
      normalizedSession.status === "running" && incomingActiveTurnId !== null
        ? {
            ...(sameEpoch && thread.latestTurn?.turnId === incomingActiveTurnId
              ? thread.latestTurn
              : {}),
            ...(sameEpoch ? {} : { terminalOutcome: undefined }),
            turnId: incomingActiveTurnId,
            state:
              sameEpoch &&
              thread.latestTurn?.turnId === incomingActiveTurnId &&
              thread.latestTurn.completedAt
                ? thread.latestTurn.state
                : "running",
            requestedAt:
              sameEpoch && thread.latestTurn?.turnId === incomingActiveTurnId
                ? thread.latestTurn.requestedAt
                : normalizedSession.updatedAt,
            startedAt:
              sameEpoch && thread.latestTurn?.turnId === incomingActiveTurnId
                ? (thread.latestTurn.startedAt ?? normalizedSession.updatedAt)
                : normalizedSession.updatedAt,
            completedAt:
              sameEpoch && thread.latestTurn?.turnId === incomingActiveTurnId
                ? (thread.latestTurn.completedAt ?? null)
                : null,
            assistantMessageId:
              sameEpoch && thread.latestTurn?.turnId === incomingActiveTurnId
                ? (thread.latestTurn.assistantMessageId ?? null)
                : null,
          }
        : thread.latestTurn,
    updatedAt: event.occurredAt,
  };
}

export function applyMobileSettlement(
  thread: OrchestrationThread,
  event: Extract<OrchestrationEvent, { type: "thread.turn-settled" }>,
): OrchestrationThread | null {
  if (event.payload.threadId !== thread.id) return null;
  const previous = thread.latestTurn;
  if (
    thread.deletedAt != null ||
    (previous && previous.turnId !== event.payload.turnId) ||
    previous?.terminalOutcome != null ||
    event.payload.sessionEpoch !== (thread.session?.sessionEpoch ?? 0)
  )
    return thread;
  return {
    ...thread,
    latestTurn: {
      ...previous,
      turnId: event.payload.turnId,
      state:
        event.payload.outcome === "completed"
          ? "completed"
          : event.payload.outcome === "failed"
            ? "error"
            : "interrupted",
      terminalOutcome: event.payload.outcome,
      requestedAt: previous?.requestedAt ?? event.occurredAt,
      startedAt: previous?.startedAt ?? event.occurredAt,
      completedAt: event.payload.completedAt,
      assistantMessageId: previous?.assistantMessageId ?? null,
    },
    updatedAt: event.occurredAt,
  };
}
