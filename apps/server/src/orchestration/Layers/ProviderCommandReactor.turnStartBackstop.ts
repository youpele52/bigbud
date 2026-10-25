import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import { Cause, Effect } from "effect";

import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { makeProviderFailureHandlers } from "./ProviderCommandReactorHandlers.failures.ts";
import { formatProviderServiceCauseDetail } from "./ProviderCommandReactorHelpers.ts";

type TurnStartRequestedEvent = Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;

/**
 * Handling a turn start can fail before the provider sees it (context expansion, settings,
 * capability state). Record that as a failed start while its pending-start gate still holds,
 * so the gate clears and the queue does not wait behind a turn that will never bind.
 */
export const failUnhandledTurnStart = Effect.fn("failUnhandledTurnStart")(function* (input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly event: TurnStartRequestedEvent;
  readonly cause: Cause.Cause<unknown>;
}) {
  const { event, orchestrationEngine } = input;
  const thread = (yield* orchestrationEngine.getReadModel()).threads.find(
    (candidate) => candidate.id === event.payload.threadId,
  );
  if (thread?.pendingTurnStart?.messageId !== event.payload.messageId) return;
  yield* makeProviderFailureHandlers(orchestrationEngine).recordTurnStartFailure({
    threadId: event.payload.threadId,
    context: "provider-turn-start",
    detail: formatProviderServiceCauseDetail(input.cause),
    failureClass: "unknown",
    createdAt: new Date().toISOString(),
    messageId: event.payload.messageId,
  });
});
