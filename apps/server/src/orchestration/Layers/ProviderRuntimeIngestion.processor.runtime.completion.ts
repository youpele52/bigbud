import type { ProviderRuntimeEvent, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { proposedPlanIdForTurn, toTurnId } from "./ProviderRuntimeIngestion.helpers.ts";
import type { RuntimeProcessorCacheHelpers } from "./ProviderRuntimeIngestion.processor.ts";
import type { makeProcessorHelpers } from "./ProviderRuntimeIngestion.processor.helpers.ts";
import type { makeThinkingProcessorHelpers } from "./ProviderRuntimeIngestion.processor.thinking.ts";

type CompletionHelpers = Pick<
  RuntimeProcessorCacheHelpers,
  "getAssistantMessageIdsForTurn" | "clearAssistantMessageIdsForTurn"
> &
  Pick<
    ReturnType<typeof makeProcessorHelpers>,
    "finalizeAssistantMessage" | "finalizeBufferedProposedPlan"
  > &
  Pick<ReturnType<typeof makeThinkingProcessorHelpers>, "finalizeThinkingForTurn">;

/** Resume all finalization after a partial terminal application; native work is never replayed. */
export const finalizeRuntimeTurn = Effect.fn("finalizeRuntimeTurn")(function* (
  event: ProviderRuntimeEvent,
  threadId: ThreadId,
  threadProposedPlans: Parameters<
    CompletionHelpers["finalizeBufferedProposedPlan"]
  >[0]["threadProposedPlans"],
  helpers: CompletionHelpers,
) {
  if (event.type !== "turn.completed") return;
  const turnId = toTurnId(event.turnId);
  if (!turnId) return;
  yield* helpers.finalizeThinkingForTurn(event, threadId, turnId);
  for (const messageId of yield* helpers.getAssistantMessageIdsForTurn(threadId, turnId)) {
    yield* helpers.finalizeAssistantMessage({
      event,
      threadId,
      messageId,
      turnId,
      createdAt: event.createdAt,
      commandTag: "assistant-complete-finalize",
      finalDeltaCommandTag: "assistant-delta-finalize-fallback",
    });
  }
  yield* helpers.clearAssistantMessageIdsForTurn(threadId, turnId);
  yield* helpers.finalizeBufferedProposedPlan({
    event,
    threadId,
    threadProposedPlans,
    planId: proposedPlanIdForTurn(threadId, turnId),
    turnId,
    updatedAt: event.createdAt,
  });
});
