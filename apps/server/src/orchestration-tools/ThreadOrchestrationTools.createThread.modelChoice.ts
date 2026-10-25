/**
 * The model-choice extension of `create_thread` (thread orchestration Goal 11): decide once, store
 * the decision in the delegation row (D2), and start or hold the delegated first turn.
 *
 * @module ThreadOrchestrationTools.createThread.modelChoice
 */
import {
  CommandId,
  EventId,
  type ModelSelection,
  type OrchestrationThread,
  type ThreadId,
} from "@bigbud/contracts";
import { DELEGATED_MODEL_CHOICE_HOLD_MS } from "@bigbud/contracts/orchestration/orchestration.delegationModelChoice";
import type { DelegatedModelChoiceRecord } from "@bigbud/shared/delegatedModelChoice";
import { Effect, Option, Schema } from "effect";

import { makeResolvedActivity } from "../orchestration/deciderThreads.delegationModelChoice.logic.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { toThreadModelChoiceStatus } from "../orchestration/ThreadWorkflowStatus.modelChoice.logic.ts";
import type {
  ThreadDelegation,
  ThreadDelegationRepositoryShape,
} from "../persistence/Services/ThreadDelegations.ts";
import type { ThreadToolModelSources } from "./ThreadOrchestrationToolDispatcher.ts";
import {
  decideModelChoice,
  ModelDecision,
  type ModelDecision as ModelDecisionType,
} from "./ThreadOrchestrationTools.modelChoice.ts";
import { loadModelChoiceContext } from "./ThreadOrchestrationTools.modelChoice.context.ts";
import { delegationError, stableThreadToolId } from "./ThreadOrchestrationTools.origins.ts";

const decodeStoredDecision = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ modelDecision: Schema.optional(ModelDecision) })),
);

export function readStoredModelDecision(resultJson: string | null): ModelDecisionType | undefined {
  if (resultJson === null) return undefined;
  return Option.getOrUndefined(decodeStoredDecision(resultJson))?.modelDecision;
}

/** Decide once per invocation; a retry reuses the stored decision and never re-decides (AC9). */
export const resolveDelegationModelDecision = Effect.fn("resolveDelegationModelDecision")(
  function* (input: {
    readonly repository: ThreadDelegationRepositoryShape;
    readonly delegation: ThreadDelegation;
    readonly identity: string;
    readonly request: unknown;
    readonly sources: ThreadToolModelSources | null | undefined;
    readonly trunk: ModelSelection;
    readonly target: {
      readonly providerRuntimeExecutionTargetId?: string | null | undefined;
      readonly workspaceExecutionTargetId?: string | null | undefined;
    };
  }) {
    const stored = readStoredModelDecision(input.delegation.resultJson);
    if (stored !== undefined) return stored;
    const context = yield* loadModelChoiceContext({ sources: input.sources, target: input.target });
    const decision = decideModelChoice({
      request: input.request,
      context,
      trunk: input.trunk,
      choiceId: stableThreadToolId("model-choice", input.identity),
      delegationId: input.delegation.delegationId,
      heldMessageId: input.delegation.sourceMessageId,
      deadlineAt: new Date(
        Date.parse(input.delegation.createdAt) + DELEGATED_MODEL_CHOICE_HOLD_MS,
      ).toISOString(),
    });
    yield* input.repository
      .storeResult({
        delegationId: input.delegation.delegationId,
        resultJson: JSON.stringify({ modelDecision: decision }),
        errorJson: null,
        updatedAt: new Date().toISOString(),
      })
      .pipe(Effect.mapError(delegationError));
    return decision;
  },
);

export function decisionThreadModel(decision: ModelDecisionType): ModelSelection {
  return decision.kind === "hold" ? decision.requested.fallback : decision.resolved.used;
}

export function decisionRecord(decision: ModelDecisionType): DelegatedModelChoiceRecord {
  return decision.kind === "hold"
    ? { status: "pending", ...decision.requested }
    : { ...decision.resolved, status: "resolved", cancelled: false };
}

/** Requested vs used for the tool result, plus usable suggestions when the request was unusable. */
export function modelChoiceResultFields(decision: ModelDecisionType) {
  const modelChoice = toThreadModelChoiceStatus(decisionRecord(decision));
  if (modelChoice.reason === null) return { modelChoice } as const;
  return {
    modelChoice,
    suggestions: decision.suggestions.map((option) => ({
      provider: option.selection.provider,
      model: option.selection.model,
      ...("subProviderID" in option.selection && option.selection.subProviderID !== undefined
        ? { subProviderID: option.selection.subProviderID }
        : {}),
      name: option.label,
      providerLabel: option.providerLabel,
      isParentModel: option.isFallback,
    })),
  } as const;
}

/**
 * Dispatches the delegated first message: an immediate decision records its resolution and starts
 * the turn with the used model; a hold queues it behind an approval-style pending choice. A failed
 * hold falls back to the trunk's model through one atomic `expire`, so the model choice never
 * fails the delegation and the delegated message is sent exactly once.
 */
export const startDelegatedFirstTurn = Effect.fn("startDelegatedFirstTurn")(function* (input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly decision: ModelDecisionType;
  readonly identity: string;
  readonly childThreadId: ThreadId;
  readonly createdAt: string;
  readonly callerThread: Pick<OrchestrationThread, "runtimeMode" | "interactionMode">;
  readonly prompt: Extract<
    Parameters<OrchestrationEngineShape["dispatch"]>[0],
    { type: "thread.delegation.model-choice.hold" }
  >["prompt"];
}) {
  const turnStart = (resolved: Extract<ModelDecisionType, { kind: "immediate" }>["resolved"]) =>
    Effect.gen(function* () {
      yield* input.orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(
          stableThreadToolId("command", `${input.identity}:model-choice-resolved`),
        ),
        threadId: input.childThreadId,
        activity: makeResolvedActivity(resolved, input.createdAt),
        createdAt: input.createdAt,
      });
      return yield* input.orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(stableThreadToolId("command", `${input.identity}:turn`)),
        threadId: input.childThreadId,
        message: { ...input.prompt, role: "user", attachments: [] },
        modelSelection: resolved.used,
        runtimeMode: input.callerThread.runtimeMode,
        interactionMode: input.callerThread.interactionMode,
        createdAt: input.createdAt,
      });
    });
  const decision = input.decision;
  if (decision.kind === "immediate") {
    return yield* turnStart(decision.resolved).pipe(Effect.mapError(delegationError));
  }
  return yield* input.orchestrationEngine
    .dispatch({
      type: "thread.delegation.model-choice.hold",
      commandId: CommandId.makeUnsafe(
        stableThreadToolId("command", `${input.identity}:model-choice-hold`),
      ),
      threadId: input.childThreadId,
      prompt: input.prompt,
      runtimeMode: input.callerThread.runtimeMode,
      interactionMode: input.callerThread.interactionMode,
      requestedActivity: {
        id: EventId.makeUnsafe(
          stableThreadToolId("activity", `${input.identity}:model-choice-requested`),
        ),
        summary: "Choose a model for this delegated thread",
        payload: decision.requested,
      },
      createdAt: input.createdAt,
    })
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning("delegated model choice hold failed; using the parent's model", {
          childThreadId: input.childThreadId,
          error: String(error),
        }).pipe(
          // The hold may have committed despite the failure (an interrupt or a timeout), so the
          // fallback is one atomic decision: it resolves a committed hold, or records the fallback
          // and starts the message; the message is never sent twice (review #2).
          Effect.andThen(
            input.orchestrationEngine.dispatch({
              type: "thread.delegation.model-choice.expire",
              commandId: CommandId.makeUnsafe(
                stableThreadToolId("command", `${input.identity}:model-choice-fallback`),
              ),
              threadId: input.childThreadId,
              choiceId: decision.requested.choiceId,
              resolvedBy: "server",
              fallbackStart: {
                prompt: input.prompt,
                runtimeMode: input.callerThread.runtimeMode,
                interactionMode: input.callerThread.interactionMode,
                requested: decision.requested,
              },
              createdAt: input.createdAt,
            }),
          ),
        ),
      ),
      Effect.mapError(delegationError),
    );
});
