import type {
  OrchestrationQueuedPrompt,
  OrchestrationThread,
  OrchestrationThreadActivity,
} from "@bigbud/contracts";
import type { PendingInteractionGate } from "@bigbud/contracts/orchestration/orchestration.pendingInteractionGate.ts";

/** Only the adapter's actual resolution (not a failed/accepted response RPC) proves closure. */
function interactionClosure(activity: OrchestrationThreadActivity) {
  const key: "approvalRequests" | "userInputRequests" | undefined =
    activity.kind === "approval.resolved"
      ? "approvalRequests"
      : activity.kind === "user-input.resolved"
        ? "userInputRequests"
        : undefined;
  const payload = activity.payload;
  if (
    key === undefined ||
    typeof payload !== "object" ||
    payload === null ||
    !("requestId" in payload) ||
    typeof payload.requestId !== "string" ||
    !("interactionSessionEpoch" in payload) ||
    typeof payload.interactionSessionEpoch !== "number" ||
    !("requestGeneration" in payload) ||
    typeof payload.requestGeneration !== "string" ||
    !("interactionProvider" in payload)
  )
    return;
  return {
    key,
    requestId: payload.requestId,
    sessionEpoch: payload.interactionSessionEpoch,
    generation: payload.requestGeneration,
    provider: payload.interactionProvider,
  } as const;
}

function closeInteraction(
  gate: PendingInteractionGate,
  closure: NonNullable<ReturnType<typeof interactionClosure>>,
) {
  if (gate.manualRecovery) return gate;
  if (gate.provider !== closure.provider || gate.sessionEpoch !== closure.sessionEpoch) return gate;
  const remaining = gate[closure.key].filter(
    (request) =>
      request.requestId !== closure.requestId || request.generation !== closure.generation,
  );
  return remaining.length === gate[closure.key].length
    ? gate
    : { ...gate, [closure.key]: remaining };
}

function hasUnclosedInteractions(gate: PendingInteractionGate) {
  return (
    gate.manualRecovery !== undefined ||
    gate.approvalRequests.length > 0 ||
    gate.userInputRequests.length > 0
  );
}

/** Admission runs under the command barrier with history loaded: a prior resolution cannot be missed. */
export function pendingInteractionGateAtAdmission(
  gate: PendingInteractionGate,
  thread: OrchestrationThread,
) {
  let remaining = gate;
  for (const activity of thread.activities) {
    const closure = interactionClosure(activity);
    if (closure) remaining = closeInteraction(remaining, closure);
    if (!hasUnclosedInteractions(remaining)) return undefined;
  }
  return hasUnclosedInteractions(remaining) ? remaining : undefined;
}

/** Both live and SQLite projections clear the durable gate on the canonical close event. */
export function queuedPromptsAfterInteractionActivity(
  prompts: ReadonlyArray<OrchestrationQueuedPrompt>,
  activity: OrchestrationThreadActivity,
): ReadonlyArray<OrchestrationQueuedPrompt> {
  if (!prompts.some((prompt) => prompt.pendingInteractionGate)) return prompts;
  const closure = interactionClosure(activity);
  if (!closure) return prompts;
  return prompts.map((prompt) => {
    const { pendingInteractionGate: gate, ...unfenced } = prompt;
    if (!gate) return prompt;
    const remaining = closeInteraction(gate, closure);
    if (remaining === gate) return prompt;
    return hasUnclosedInteractions(remaining)
      ? { ...unfenced, pendingInteractionGate: remaining }
      : unfenced;
  });
}

/** Session replacement or terminal status alone never proves a provider interaction closed. */
export function hasPendingInteractionGate(thread: OrchestrationThread) {
  return (
    thread.queuedPrompts?.some((prompt) => prompt.pendingInteractionGate !== undefined) ?? false
  );
}
