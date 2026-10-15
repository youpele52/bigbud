import {
  CommandId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ThreadId,
} from "@bigbud/contracts";
import {
  DELEGATED_MODEL_CHOICE_HOLD_MS,
  DELEGATION_MODEL_CHOICE_REQUESTED_ACTIVITY_KIND,
  DELEGATION_MODEL_CHOICE_RESOLVED_ACTIVITY_KIND,
  type DelegationModelChoiceRequested,
} from "@bigbud/contracts/orchestration/orchestration.delegationModelChoice";
import { derivePendingDelegatedModelChoice } from "@bigbud/shared/delegatedModelChoice";

/** Catches timers lost to a crash or a missed event; startup runs the first sweep at once. */
export const MODEL_CHOICE_SWEEP_INTERVAL_MS = 30_000;
export const MODEL_CHOICE_SWEEP_BATCH = 100;
export const MODEL_CHOICE_EXPIRE_ATTEMPTS = 3;

export interface PendingModelChoice {
  readonly threadId: ThreadId;
  readonly request: DelegationModelChoiceRequested;
}

/** Never longer than the hold itself, whatever a stored deadline says. */
export function modelChoiceExpiryDelayMs(deadlineAt: string, nowMs: number): number {
  const deadlineMs = Date.parse(deadlineAt);
  if (!Number.isFinite(deadlineMs)) return 0;
  return Math.min(DELEGATED_MODEL_CHOICE_HOLD_MS, Math.max(0, deadlineMs - nowMs));
}

export function pendingModelChoiceFromRow(row: {
  readonly threadId: ThreadId;
  readonly payload: unknown;
}): PendingModelChoice | null {
  const request = derivePendingDelegatedModelChoice([
    { kind: DELEGATION_MODEL_CHOICE_REQUESTED_ACTIVITY_KIND, payload: row.payload },
  ]);
  return request === null ? null : { threadId: row.threadId, request };
}

export function modelChoiceEventEffect(
  event: OrchestrationEvent,
):
  | { readonly type: "requested"; readonly choice: PendingModelChoice }
  | { readonly type: "resolved"; readonly choiceId: string }
  | null {
  if (event.type !== "thread.activity-appended") return null;
  const { activity, threadId } = event.payload;
  if (activity.kind === DELEGATION_MODEL_CHOICE_REQUESTED_ACTIVITY_KIND) {
    const choice = pendingModelChoiceFromRow({ threadId, payload: activity.payload });
    return choice === null ? null : { type: "requested", choice };
  }
  if (activity.kind === DELEGATION_MODEL_CHOICE_RESOLVED_ACTIVITY_KIND) {
    const choiceId =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as { readonly choiceId?: unknown }).choiceId
        : undefined;
    return typeof choiceId === "string" ? { type: "resolved", choiceId } : null;
  }
  return null;
}

/**
 * The timer's command id is stable per choice (its retries reuse one command). A sweep attempt has
 * its own id per attempt, so a later sweep never conflicts with an earlier receipt. Resolution is
 * idempotent in the decider: the first one wins and later ones decide nothing.
 */
export function expireModelChoiceCommand(input: {
  readonly choice: PendingModelChoice;
  readonly resolvedBy: "timeout" | "restart-sweep";
  readonly createdAt: string;
}): OrchestrationCommand {
  const choiceId = input.choice.request.choiceId;
  return {
    type: "thread.delegation.model-choice.expire",
    commandId: CommandId.makeUnsafe(
      input.resolvedBy === "timeout"
        ? `model-choice-expire:${choiceId}`
        : `model-choice-sweep:${choiceId}:${input.createdAt}`,
    ),
    threadId: input.choice.threadId,
    choiceId: input.choice.request.choiceId,
    resolvedBy: input.resolvedBy,
    createdAt: input.createdAt,
  };
}
