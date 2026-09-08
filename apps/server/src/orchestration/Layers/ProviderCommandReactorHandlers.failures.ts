import { EventId, ThreadId, type TurnId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { serverCommandId } from "./ProviderCommandReactorHelpers.ts";

export type ProviderFailureActivityInput = {
  readonly threadId: ThreadId;
  readonly kind:
    | "provider.turn.start.failed"
    | "provider.turn.interrupt.failed"
    | "provider.turn.steer.failed"
    | "provider.approval.respond.failed"
    | "provider.user-input.respond.failed"
    | "provider.session.stop.failed";
  readonly summary: string;
  readonly detail: string;
  readonly turnId: TurnId | null;
  readonly createdAt: string;
  readonly requestId?: string;
};

export type TurnStartFailureInput = {
  readonly threadId: ThreadId;
  readonly context: "message-validation" | "provider-session-start" | "provider-turn-start";
  readonly detail: string;
  readonly createdAt: string;
};

const normalizeTurnStartFailureDetail = (detail: string): string => {
  const normalized = detail.replace(/\s+/g, " ").trim().slice(0, 2_000);
  return normalized.length > 0 ? normalized : "Provider turn start failed.";
};

export function makeProviderFailureHandlers(orchestrationEngine: OrchestrationEngineShape) {
  const appendProviderFailureActivity = (input: ProviderFailureActivityInput) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("provider-failure-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: input.kind,
        summary: input.summary,
        payload: {
          detail: input.detail,
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const emitTurnStartFailure = (input: TurnStartFailureInput) =>
    orchestrationEngine.dispatch({
      type: "thread.turn.start.failed",
      commandId: serverCommandId("provider-turn-start-failed"),
      threadId: input.threadId,
      context: input.context,
      detail: normalizeTurnStartFailureDetail(input.detail),
      createdAt: input.createdAt,
    });

  const recordTurnStartFailure = (input: TurnStartFailureInput) =>
    Effect.gen(function* () {
      const detail = normalizeTurnStartFailureDetail(input.detail);
      yield* emitTurnStartFailure({ ...input, detail });
      yield* appendProviderFailureActivity({
        threadId: input.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail,
        turnId: null,
        createdAt: input.createdAt,
      });
    });

  return { appendProviderFailureActivity, recordTurnStartFailure };
}
