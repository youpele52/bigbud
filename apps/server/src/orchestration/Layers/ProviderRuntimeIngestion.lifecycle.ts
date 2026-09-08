import type {
  OrchestrationThread,
  ProviderRuntimeEvent,
  ProviderSession,
  TurnId,
} from "@bigbud/contracts";
import { PROVIDER_RECOVERING_SESSION_REASON } from "@bigbud/contracts/constants/providerRuntime.constant";

import { STRICT_PROVIDER_LIFECYCLE_GUARD, sameId } from "./ProviderRuntimeIngestion.helpers.ts";

export function isProviderLifecycleEvent(event: ProviderRuntimeEvent): boolean {
  return (
    event.type === "session.exited" ||
    event.type === "session.started" ||
    event.type === "session.state.changed" ||
    event.type === "thread.started" ||
    event.type === "turn.started" ||
    event.type === "turn.completed" ||
    event.type === "turn.aborted"
  );
}

export function resolveProviderLifecycleGuard(input: {
  readonly event: ProviderRuntimeEvent;
  readonly thread: OrchestrationThread;
  readonly liveSession: ProviderSession | undefined;
  readonly activeTurnId: TurnId | null;
  readonly eventTurnId: TurnId | undefined;
}): {
  readonly shouldApply: boolean;
  readonly providerConflictsWithLiveSession: boolean;
  readonly conflictsWithLiveTurn: boolean;
  readonly missingTurnForLiveTurn: boolean;
  readonly sessionEpochMismatch: boolean;
  readonly rejectionReason:
    | "provider-mismatch"
    | "missing-turn-id"
    | "turn-mismatch"
    | "session-epoch-mismatch"
    | "strict-lifecycle-guard"
    | null;
} {
  const conflictsWithActiveTurn =
    input.activeTurnId !== null &&
    input.eventTurnId !== undefined &&
    !sameId(input.activeTurnId, input.eventTurnId);
  const missingTurnForActiveTurn = input.activeTurnId !== null && input.eventTurnId === undefined;
  const conflictsWithLiveTurn =
    input.liveSession?.activeTurnId != null &&
    input.eventTurnId !== undefined &&
    !sameId(input.liveSession.activeTurnId, input.eventTurnId);
  const missingTurnForLiveTurn =
    input.liveSession?.activeTurnId != null && input.eventTurnId === undefined;
  const providerConflictsWithLiveSession =
    input.liveSession !== undefined && input.liveSession.provider !== input.event.provider;
  const sessionEpochMismatch =
    input.liveSession?.sessionEpoch !== undefined &&
    input.liveSession.sessionEpoch !== (input.thread.session?.sessionEpoch ?? 0);
  const isRecoveryStateChangedEvent =
    input.event.type === "session.state.changed" &&
    input.event.payload.reason === PROVIDER_RECOVERING_SESSION_REASON;
  const recoveryTurnMismatch =
    isRecoveryStateChangedEvent &&
    ((input.eventTurnId === undefined &&
      (input.activeTurnId !== null || input.liveSession?.activeTurnId != null)) ||
      (input.eventTurnId !== undefined &&
        input.activeTurnId === null &&
        input.liveSession?.activeTurnId == null) ||
      conflictsWithActiveTurn ||
      missingTurnForActiveTurn ||
      conflictsWithLiveTurn ||
      missingTurnForLiveTurn);

  if (!STRICT_PROVIDER_LIFECYCLE_GUARD && !isRecoveryStateChangedEvent) {
    return {
      shouldApply: true,
      providerConflictsWithLiveSession,
      conflictsWithLiveTurn,
      missingTurnForLiveTurn,
      sessionEpochMismatch,
      rejectionReason: null,
    };
  }

  const rejected =
    providerConflictsWithLiveSession ||
    sessionEpochMismatch ||
    recoveryTurnMismatch ||
    (input.event.type === "turn.started" && conflictsWithActiveTurn) ||
    (input.event.type === "session.exited" && (conflictsWithLiveTurn || missingTurnForLiveTurn)) ||
    ((input.event.type === "turn.completed" || input.event.type === "turn.aborted") &&
      (conflictsWithActiveTurn ||
        missingTurnForActiveTurn ||
        conflictsWithLiveTurn ||
        missingTurnForLiveTurn));
  const rejectionReason = providerConflictsWithLiveSession
    ? "provider-mismatch"
    : sessionEpochMismatch
      ? "session-epoch-mismatch"
      : missingTurnForActiveTurn || missingTurnForLiveTurn
        ? "missing-turn-id"
        : conflictsWithActiveTurn || conflictsWithLiveTurn
          ? "turn-mismatch"
          : rejected
            ? "strict-lifecycle-guard"
            : null;

  return {
    shouldApply: !rejected,
    providerConflictsWithLiveSession,
    conflictsWithLiveTurn,
    missingTurnForLiveTurn,
    sessionEpochMismatch,
    rejectionReason,
  };
}
