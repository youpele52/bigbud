import {
  EventId,
  type ModelSelection,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@bigbud/contracts";
import { Cause, Effect } from "effect";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import {
  successfulRuntimeModel,
  SUCCESSFUL_GENERATION_MODEL_ACTIVITY,
} from "../../git/Layers/InternalTextGeneration.success.ts";
import { providerCommandId } from "./ProviderRuntimeIngestion.processor.runtime.command.ts";

/** Keep success bookkeeping and tracing off the streaming-delta hot path. */
export function isSuccessfulModelEvent(event: ProviderRuntimeEvent): boolean {
  return (
    event.type === "turn.started" ||
    event.type === "turn.completed" ||
    event.type === "turn.aborted" ||
    event.type === "session.exited"
  );
}

/** Capture actual runtime identity at turn start; selection changes cannot rewrite it. */
export function makeSuccessfulModelRecorder(engine: Pick<OrchestrationEngineShape, "dispatch">) {
  const turnModels = new Map<string, ModelSelection>();
  return Effect.fn("recordSuccessfulThreadModel")(function* (
    event: ProviderRuntimeEvent,
    thread: OrchestrationThread,
    liveSession: ProviderSession | undefined,
  ) {
    const prefix = `${thread.id}:`;
    const epoch = thread.session?.sessionEpoch ?? 0;
    if (event.sessionEpoch !== undefined && event.sessionEpoch !== epoch) return;
    if (liveSession?.sessionEpoch !== undefined && liveSession.sessionEpoch !== epoch) return;
    const key = `${prefix}${epoch}:${event.provider}:${event.turnId}`;
    if (event.type === "turn.started" && event.turnId) {
      const model =
        event.payload.modelSelection?.provider === event.provider
          ? event.payload.modelSelection
          : event.payload.model
            ? successfulRuntimeModel(
                {
                  ...liveSession,
                  provider: event.provider,
                  model: event.payload.model,
                } as ProviderSession,
                thread.modelSelection,
              )
            : liveSession?.activeTurnId === event.turnId && liveSession.provider === event.provider
              ? successfulRuntimeModel(liveSession, thread.modelSelection)
              : null;
      for (const cached of turnModels.keys())
        if (cached.startsWith(prefix)) turnModels.delete(cached);
      if (model) turnModels.set(key, model);
    }
    if (event.type === "turn.aborted") turnModels.delete(key);
    if (event.type === "session.exited") {
      for (const cached of turnModels.keys())
        if (cached.startsWith(prefix)) turnModels.delete(cached);
    }
    if (event.type !== "turn.completed" || !event.turnId) return;
    if (
      event.payload.actualModelSelection &&
      event.payload.actualModelSelection.provider !== event.provider
    )
      return;
    if (
      (thread.latestTurn && thread.latestTurn.turnId !== event.turnId) ||
      (thread.session?.activeTurnId && thread.session.activeTurnId !== event.turnId) ||
      (liveSession?.activeTurnId && liveSession.activeTurnId !== event.turnId)
    )
      return;
    const model =
      event.payload.actualModelSelection?.provider === event.provider
        ? event.payload.actualModelSelection
        : turnModels.get(key);
    turnModels.delete(key);
    if (event.payload.state !== "completed" || !model) return;
    yield* engine
      .dispatch({
        type: "thread.activity.append",
        commandId: providerCommandId(event, "successful-text-generation-model"),
        threadId: thread.id,
        activity: {
          id: EventId.makeUnsafe(`text-generation-model:${event.eventId}`),
          kind: SUCCESSFUL_GENERATION_MODEL_ACTIVITY,
          tone: "info",
          summary: "Successful thread model",
          payload: model,
          turnId: event.turnId,
          createdAt: event.createdAt,
        },
        createdAt: event.createdAt,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("failed to record successful thread model", {
                threadId: thread.id,
                cause: Cause.pretty(cause),
              }),
        ),
      );
  });
}
