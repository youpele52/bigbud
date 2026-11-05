import type { ProviderRuntimeEvent, ProviderSession, TurnId } from "@bigbud/contracts";

import type { MuseSessionState } from "./Adapter.types.ts";

/**
 * Stamps the orchestration session epoch on a Muse runtime event. Ingestion
 * drops non-lifecycle output whose epoch differs from the projected thread
 * session, and turn-liveness claims terminals per epoch, so an unstamped event
 * is silently lost once the thread's epoch is above zero.
 */
export function stampMuseEvent(
  event: ProviderRuntimeEvent,
  sessionEpoch: number,
): ProviderRuntimeEvent {
  return { ...event, sessionEpoch } as ProviderRuntimeEvent;
}

/** Records the session's foreground turn, advancing `updatedAt` only on a real change. */
export function setMuseActiveTurn(state: MuseSessionState, turnId: TurnId | undefined): void {
  if (state.activeTurnId === turnId) return;
  state.activeTurnId = turnId;
  state.updatedAt = new Date().toISOString();
}

/**
 * The live session as ProviderService sees it. A running foreground turn must
 * be reported: sendTurn treats an idle live session as "turn already finished"
 * and claims its terminal, and the periodic reconciler copies this view into
 * the thread session.
 */
export function museProviderSession(state: MuseSessionState): ProviderSession {
  const running =
    state.activeTurnId !== undefined ||
    state.queuedTurns.size > 0 ||
    state.hasUnidentifiedQueuedInputs === true;
  return {
    provider: "muse",
    status: running ? "running" : "ready",
    runtimeMode: state.runtimeMode as ProviderSession["runtimeMode"],
    threadId: state.threadId,
    cwd: state.workspace,
    model: state.model,
    sessionEpoch: state.sessionEpoch,
    ...(state.activeTurnId ? { activeTurnId: state.activeTurnId } : {}),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}
