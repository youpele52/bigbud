import type {
  OrchestrationThread,
  ProviderRuntimeEvent,
  ProviderSession,
  TurnId,
} from "@bigbud/contracts";

import { STRICT_PROVIDER_LIFECYCLE_GUARD, sameId } from "./ProviderRuntimeIngestion.helpers.ts";

export function isProviderLifecycleEvent(event: ProviderRuntimeEvent): boolean {
  return (
    event.type === "session.exited" ||
    event.type === "session.started" ||
    event.type === "session.state.changed" ||
    event.type === "thread.started" ||
    event.type === "turn.started" ||
    event.type === "turn.completed"
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
  readonly rejectionReason:
    | "provider-mismatch"
    | "missing-turn-id"
    | "turn-mismatch"
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

  if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
    return {
      shouldApply: true,
      providerConflictsWithLiveSession,
      conflictsWithLiveTurn,
      missingTurnForLiveTurn,
      rejectionReason: null,
    };
  }

  const rejected =
    providerConflictsWithLiveSession ||
    (input.event.type === "turn.started" && conflictsWithActiveTurn) ||
    (input.event.type === "session.exited" && (conflictsWithLiveTurn || missingTurnForLiveTurn)) ||
    (input.event.type === "turn.completed" &&
      (conflictsWithActiveTurn ||
        missingTurnForActiveTurn ||
        conflictsWithLiveTurn ||
        missingTurnForLiveTurn));
  const rejectionReason = providerConflictsWithLiveSession
    ? "provider-mismatch"
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
    rejectionReason,
  };
}
