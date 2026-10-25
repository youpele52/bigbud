import { Schema } from "effect";
import { ModelSelection, type OrchestrationThread, type ProviderSession } from "@bigbud/contracts";

export const SUCCESSFUL_GENERATION_MODEL_ACTIVITY = "text-generation.model-succeeded";

/** Do not infer success from selection, session readiness, partial output, or failed turns. */
export function lastSuccessfulThreadModel(
  thread: Pick<OrchestrationThread, "activities">,
): ModelSelection | null {
  const activities = thread.activities ?? [];
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.kind !== SUCCESSFUL_GENERATION_MODEL_ACTIVITY) continue;
    if (Schema.is(ModelSelection)(activity.payload)) return activity.payload;
  }
  return null;
}

/** Bind the model to its actual runtime provider, never to a newly selected provider. */
export function successfulRuntimeModel(
  session: ProviderSession | undefined,
  selected: ModelSelection,
): ModelSelection | null {
  if (!session?.model) return null;
  if (session.provider === selected.provider && session.model === selected.model) return selected;
  const candidate = { provider: session.provider, model: session.model };
  return Schema.is(ModelSelection)(candidate) ? candidate : null;
}
