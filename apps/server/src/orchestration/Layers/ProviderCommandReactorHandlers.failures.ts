import { EventId, type MessageId, ThreadId, type TurnId } from "@bigbud/contracts";
import type {
  TurnStartFailureClass,
  TurnStartRemoteTargetFailure,
} from "@bigbud/contracts/orchestration/orchestration.turnFailure.ts";
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
  readonly failureClass?: TurnStartFailureClass;
  /** Set when the turn failed because its remote (SSH) target was unavailable. */
  readonly remoteTarget?: TurnStartRemoteTargetFailure;
  /** The user message whose turn start failed; a fork reads only that message's failure. */
  readonly messageId?: MessageId;
  /** Deterministic id so a fork can name the failure it continues from. */
  readonly activityId?: EventId;
};

export type TurnStartFailureInput = {
  readonly threadId: ThreadId;
  readonly context: "message-validation" | "provider-session-start" | "provider-turn-start";
  readonly detail: string;
  readonly failureClass: TurnStartFailureClass;
  readonly createdAt: string;
  readonly messageId?: MessageId;
  readonly activityId?: EventId;
  /** Activity-payload only (`thread.turn.start.failed` stays unchanged on the wire). */
  readonly remoteTarget?: TurnStartRemoteTargetFailure;
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
        id: input.activityId ?? EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: input.kind,
        summary: input.summary,
        payload: {
          detail: input.detail,
          ...(input.requestId ? { requestId: input.requestId } : {}),
          ...(input.failureClass ? { failureClass: input.failureClass } : {}),
          ...(input.remoteTarget ? { remoteTarget: input.remoteTarget } : {}),
          ...(input.messageId ? { messageId: input.messageId } : {}),
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
      failureClass: input.failureClass,
      ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
      createdAt: input.createdAt,
    });

  const recordTurnStartFailure = (input: TurnStartFailureInput) =>
    Effect.gen(function* () {
      const { remoteTarget, ...failure } = input;
      const detail = normalizeTurnStartFailureDetail(input.detail);
      yield* emitTurnStartFailure({ ...failure, detail });
      yield* appendProviderFailureActivity({
        threadId: input.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail,
        failureClass: input.failureClass,
        ...(remoteTarget !== undefined ? { remoteTarget } : {}),
        turnId: null,
        createdAt: input.createdAt,
        ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
        ...(input.activityId !== undefined ? { activityId: input.activityId } : {}),
      });
    });

  return { appendProviderFailureActivity, recordTurnStartFailure };
}
