import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect } from "effect";

import type { ActivePiSession, PiEmitEvents, PiSyntheticEventFn } from "./Adapter.types.ts";
import { eventBase, isRecord, normalizeString } from "./Adapter.utils.ts";

export const settlePiAgentEnd = Effect.fn("settlePiAgentEnd")(function* (deps: {
  readonly emit: PiEmitEvents;
  readonly makeSyntheticEvent: PiSyntheticEventFn;
  readonly session: ActivePiSession;
}) {
  if (
    !deps.session.agentRunning &&
    !deps.session.activeTurnId &&
    !deps.session.completedTurnBoundary
  ) {
    return;
  }

  deps.session.updatedAt = new Date().toISOString();
  deps.session.missingAgentEndRecoveryToken = undefined;
  deps.session.agentRunning = false;
  const boundary = deps.session.completedTurnBoundary;
  const finalTurnId = deps.session.activeTurnId;

  const nextQueuedTurnId = deps.session.queuedTurnIds.shift();
  if (nextQueuedTurnId) {
    deps.session.activeTurnId = nextQueuedTurnId;
    deps.session.completedTurnBoundary = undefined;
    return yield* deps.emit([
      yield* deps.makeSyntheticEvent(deps.session.threadId, "session.state.changed", {
        state: "running",
        reason: "turn.queued",
      }),
    ]);
  }

  deps.session.activeTurnId = undefined;
  deps.session.completedTurnBoundary = undefined;
  deps.session.pendingTurnEnd = undefined;

  const events: ProviderRuntimeEvent[] = [];
  if (boundary) {
    const messageRecord = isRecord(boundary.message.message) ? boundary.message.message : undefined;
    const stopReason = normalizeString(messageRecord?.stopReason);
    const errorMessage = normalizeString(messageRecord?.errorMessage);
    events.push({
      ...eventBase({
        eventId: boundary.stamp.eventId,
        createdAt: boundary.stamp.createdAt,
        threadId: deps.session.threadId,
        ...(finalTurnId ? { turnId: finalTurnId } : {}),
        raw: boundary.raw,
      }),
      type: "turn.completed",
      payload: {
        state:
          stopReason === "aborted"
            ? "interrupted"
            : stopReason === "error"
              ? "failed"
              : "completed",
        ...(stopReason ? { stopReason } : {}),
        ...(errorMessage ? { errorMessage } : {}),
      },
    } as ProviderRuntimeEvent);
  }
  events.push(
    yield* deps.makeSyntheticEvent(deps.session.threadId, "session.state.changed", {
      state: "ready",
      reason: "agent_end",
    }),
  );
  return yield* deps.emit(events);
});
