/**
 * Pure helpers for the delegated model-choice decider (Goal 11 of thread orchestration).
 *
 * @module deciderThreads.delegationModelChoice.logic
 */
import {
  EventId,
  type ModelSelection,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@bigbud/contracts";
import {
  DELEGATION_MODEL_CHOICE_RESOLVED_ACTIVITY_KIND,
  type DelegationModelChoiceRequested,
  type DelegationModelChoiceResolved,
  type ModelChoiceOption,
} from "@bigbud/contracts/orchestration/orchestration.delegationModelChoice";
import { modelSelectionKey } from "@bigbud/shared/delegatedModelChoice";

export function findOfferedOption(
  pending: DelegationModelChoiceRequested,
  selection: ModelSelection,
): ModelChoiceOption | undefined {
  const key = modelSelectionKey(selection);
  return pending.options.find((option) => modelSelectionKey(option.selection) === key);
}

export function resolvedActivityId(choiceId: string): EventId {
  return EventId.makeUnsafe(`${choiceId}:resolved`);
}

export function resolutionSummary(payload: DelegationModelChoiceResolved): string {
  if (payload.cancelled) return "Model choice cancelled";
  if (payload.outcome === "requested") return `Using requested model ${payload.used.model}`;
  if (payload.outcome === "user-picked") return `Using chosen model ${payload.used.model}`;
  return `Using fallback model ${payload.used.model}`;
}

export function makeResolvedActivity(
  payload: DelegationModelChoiceResolved,
  createdAt: string,
): OrchestrationThreadActivity {
  return {
    id: resolvedActivityId(payload.choiceId),
    tone: "info",
    kind: DELEGATION_MODEL_CHOICE_RESOLVED_ACTIVITY_KIND,
    summary: resolutionSummary(payload),
    payload,
    turnId: null,
    createdAt,
  };
}

/**
 * The read model the held message is started against: the choice is resolved, the thread uses the
 * chosen model and the held message has left the queue, so dispatch safety no longer blocks it.
 */
export function resolvedReadModel(input: {
  readonly readModel: OrchestrationReadModel;
  readonly thread: OrchestrationThread;
  readonly activity: OrchestrationThreadActivity;
  readonly used: ModelSelection;
  readonly heldMessageId: string;
}): { readonly readModel: OrchestrationReadModel; readonly thread: OrchestrationThread } {
  const thread: OrchestrationThread = {
    ...input.thread,
    modelSelection: input.used,
    activities: [...input.thread.activities, input.activity],
    queuedPrompts: (input.thread.queuedPrompts ?? []).filter(
      (prompt) => prompt.id !== input.heldMessageId,
    ),
  };
  return {
    thread,
    readModel: {
      ...input.readModel,
      threads: input.readModel.threads.map((candidate) =>
        candidate.id === thread.id ? thread : candidate,
      ),
    },
  };
}
