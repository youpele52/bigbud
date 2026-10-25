import { Effect } from "effect";
import type { TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.ts";
import type { ActivePiSession, PiEmitEvents, PiSyntheticEventFn } from "./Adapter.types.ts";
import { isRecord, normalizeString } from "./Adapter.utils.ts";

interface SettlementDependencies {
  readonly emit: PiEmitEvents;
  readonly makeSyntheticEvent: PiSyntheticEventFn;
  readonly session: ActivePiSession;
}

/** A settled run includes all steering/follow-up work, not just its last low-level agent run. */
export const settlePiRun = Effect.fn("settlePiRun")(function* (
  deps: SettlementDependencies & { readonly aborted: boolean },
) {
  const session = deps.session;
  const ids = [
    ...new Set(
      [...(session.settlingTurnIds ?? []), session.activeTurnId, ...session.queuedTurnIds].filter(
        (id): id is TurnId => id !== undefined,
      ),
    ),
  ];
  if (!session.agentRunning && ids.length === 0) return;
  const message = session.completedTurnBoundary?.message.message;
  const stopReason = isRecord(message) ? normalizeString(message.stopReason) : undefined;
  const errorMessage = isRecord(message) ? normalizeString(message.errorMessage) : undefined;
  session.agentRunning = false;
  session.activeTurnId = undefined;
  session.queuedTurnIds.length = 0;
  session.pendingPromptTurnIds?.clear();
  session.pendingPromptQueueStarts?.clear();
  delete session.promptQueue;
  session.settlingTurnIds?.clear();
  session.completedTurnBoundary = undefined;
  session.pendingTurnEnd = undefined;
  session.missingAgentEndRecoveryToken = undefined;
  session.updatedAt = new Date().toISOString();
  const events = [];
  for (const turnId of ids) {
    events.push(
      yield* deps.makeSyntheticEvent(
        session.threadId,
        session.sessionEpoch,
        "turn.completed",
        {
          state:
            deps.aborted || stopReason === "aborted"
              ? "interrupted"
              : stopReason === "error"
                ? "failed"
                : "completed",
          ...(stopReason ? { stopReason } : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
        { turnId },
      ),
    );
  }
  events.push(
    yield* deps.makeSyntheticEvent(
      session.threadId,
      session.sessionEpoch,
      "session.state.changed",
      {
        state: "ready",
        reason: "agent_settled",
      },
    ),
  );
  yield* deps.emit(events);
});

/** Extension-handled prompts do not start a run and will never emit agent_settled. */
export const settleHandledPiPrompt = Effect.fn("settleHandledPiPrompt")(function* (
  deps: SettlementDependencies & { readonly turnId: TurnId },
) {
  const { session, turnId } = deps;
  session.pendingPromptTurnIds?.delete(turnId);
  session.pendingPromptQueueStarts?.delete(turnId);
  if (session.activeTurnId !== turnId && !session.queuedTurnIds.includes(turnId)) return;
  if (session.activeTurnId === turnId) session.activeTurnId = undefined;
  const queued = session.queuedTurnIds.indexOf(turnId);
  if (queued !== -1) session.queuedTurnIds.splice(queued, 1);
  const events: ProviderRuntimeEvent[] = [
    yield* deps.makeSyntheticEvent(
      session.threadId,
      session.sessionEpoch,
      "turn.completed",
      {
        state: "completed",
        stopReason: "handled",
      },
      { turnId },
    ),
  ];
  if (!session.activeTurnId && !session.agentRunning) {
    events.push(
      yield* deps.makeSyntheticEvent(
        session.threadId,
        session.sessionEpoch,
        "session.state.changed",
        {
          state: "ready",
          reason: "prompt.handled",
        },
      ),
    );
  }
  yield* deps.emit(events);
});
