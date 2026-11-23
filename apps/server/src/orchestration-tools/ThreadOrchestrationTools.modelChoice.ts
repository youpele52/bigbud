/**
 * The delegating agent's model request on `create_thread` (thread orchestration Goal 11): a usable
 * request is honored; anything else falls back to the trunk's model, optionally after a short hold
 * for a connected user's pick. The decision never fails.
 *
 * @module ThreadOrchestrationTools.modelChoice
 */
import {
  MessageId,
  type ModelSelection,
  PROVIDER_KINDS,
  type ProviderKind,
} from "@bigbud/contracts";
import {
  DELEGATED_MODEL_CHOICE_MAX_OPTIONS,
  type DelegationEffortDecision,
  DelegationModelChoiceRequested,
  DelegationModelChoiceResolved,
  ModelChoiceOption,
  type ModelChoiceUnusableReason,
  RequestedModelSelection,
} from "@bigbud/contracts/orchestration/orchestration.delegationModelChoice";
import { modelSelectionKey } from "@bigbud/shared/delegatedModelChoice";
import { resolveSelectableModel } from "@bigbud/shared/model";
import { isRetiredProvider } from "@bigbud/shared/providerLifecycle";
import { Option, Schema } from "effect";

import {
  configureDelegatedEffort,
  readDelegatedEffort,
} from "./ThreadOrchestrationTools.modelChoice.effort.ts";
import {
  isUsableProviderModel,
  listRankedUsableModels,
  type ModelChoiceContext,
  providerUnusableReason,
  selectionFor,
} from "./ThreadOrchestrationTools.modelChoice.usable.ts";

export {
  listRankedUsableModels,
  type ModelChoiceContext,
  type RecentModelSelection,
} from "./ThreadOrchestrationTools.modelChoice.usable.ts";

export const MODEL_CHOICE_SUGGESTION_LIMIT = 10;

/** The decision stored in the delegation row's `resultJson` (D2); decoded on retry. */
export const ModelDecision = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("immediate"),
    resolved: DelegationModelChoiceResolved,
    suggestions: Schema.Array(ModelChoiceOption),
  }),
  Schema.Struct({
    kind: Schema.Literal("hold"),
    requested: DelegationModelChoiceRequested,
    suggestions: Schema.Array(ModelChoiceOption),
  }),
]);
export type ModelDecision = typeof ModelDecision.Type;

const decodeRequested = Schema.decodeUnknownOption(RequestedModelSelection);

/**
 * A request names a provider; anything else means "no request" at every entry point, exactly like
 * an omitted field: no hold, no picker, today's behavior (L5). So `null`, `{}`, `{ provider: null }`,
 * `{ provider: "" }`, a whitespace-only provider and `{ model }` without a provider are all absent.
 * Non-object values (a bare string, an array) are still requests and fall back as invalid.
 */
export function isAbsentModelSelection(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const provider = (value as { readonly provider?: unknown }).provider;
  return typeof provider !== "string" || provider.trim().length === 0;
}

/** Lenient transport input to a bounded request; agent-set `options` are dropped (OD5). */
export function parseRequestedModelSelection(value: unknown): RequestedModelSelection | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { provider, model, subProviderID } = value as Record<string, unknown>;
  const effort = readDelegatedEffort(value)?.requested;
  return Option.getOrNull(
    decodeRequested({
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(subProviderID !== undefined ? { subProviderID } : {}),
      ...(effort !== undefined ? { effort } : {}),
    }),
  );
}

function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_KINDS as ReadonlyArray<string>).includes(value);
}

function resolveRequested(
  requested: RequestedModelSelection,
  context: ModelChoiceContext,
  trunk: ModelSelection,
):
  | { readonly selection: ModelSelection; readonly ambiguousEffortIdentity?: true }
  | { readonly reason: ModelChoiceUnusableReason } {
  if (isRetiredProvider(requested.provider)) return { reason: "provider-retired" };
  const snapshot = isProviderKind(requested.provider)
    ? context.providers.find((candidate) => candidate.provider === requested.provider)
    : undefined;
  if (!snapshot) return { reason: "unknown-provider" };
  const providerReason = providerUnusableReason(snapshot, context);
  if (providerReason !== null) return { reason: providerReason };

  const candidates = snapshot.models.filter(
    (model) =>
      requested.subProviderID === undefined || model.subProviderID === requested.subProviderID,
  );
  if (requested.model === undefined) {
    const usable = new Map(
      candidates
        .filter(isUsableProviderModel)
        .map((model) => [
          modelSelectionKey({ ...model, provider: snapshot.provider, model: model.slug }),
          model,
        ]),
    );
    // `recent` is newest first, so the first usable hit is the most recently used model.
    const model =
      context.recent
        .map((entry) => usable.get(modelSelectionKey(entry)))
        .find((candidate) => candidate !== undefined) ?? usable.values().next().value;
    return model
      ? { selection: selectionFor(snapshot.provider, model, trunk) }
      : { reason: "unknown-model" };
  }
  const slug = resolveSelectableModel(snapshot.provider, requested.model, candidates);
  const matching = slug === null ? [] : candidates.filter((candidate) => candidate.slug === slug);
  const named =
    requested.model !== slug
      ? matching.filter(
          (candidate) => candidate.name.toLowerCase() === requested.model?.toLowerCase(),
        )
      : [];
  const model = named.length === 1 ? named[0] : matching[0];
  if (!model) return { reason: "unknown-model" };
  if (!isUsableProviderModel(model)) return { reason: "model-requires-setup" };
  return {
    selection: selectionFor(snapshot.provider, model, trunk),
    ...(matching.length > 1 && named.length !== 1 ? { ambiguousEffortIdentity: true } : {}),
  };
}

function withFallbackOption(
  ranked: ReadonlyArray<ModelChoiceOption>,
  trunk: ModelSelection,
): ReadonlyArray<ModelChoiceOption> {
  const capped = ranked.slice(0, DELEGATED_MODEL_CHOICE_MAX_OPTIONS);
  if (capped.some((option) => option.isFallback)) return capped;
  const fallback: ModelChoiceOption = ranked.find((option) => option.isFallback) ?? {
    selection: trunk,
    label: trunk.model,
    providerLabel: trunk.provider,
    lastUsedAt: null,
    isFallback: true,
  };
  return [fallback, ...capped.slice(0, DELEGATED_MODEL_CHOICE_MAX_OPTIONS - 1)];
}

export function decideModelChoice(input: {
  readonly request: unknown;
  /** `null` when provider snapshots or settings are unavailable. */
  readonly context: ModelChoiceContext | null;
  readonly trunk: ModelSelection;
  readonly choiceId: string;
  readonly delegationId: string;
  readonly heldMessageId: string;
  readonly deadlineAt: string;
}): ModelDecision {
  const requested = parseRequestedModelSelection(input.request);
  const effort = isAbsentModelSelection(input.request)
    ? undefined
    : readDelegatedEffort(input.request);
  const unapplied = (reason: "model-not-selected" | "agent-choice-disabled") =>
    effort === undefined ? {} : { effort: { ...effort, reason: effort.reason ?? reason } };
  const immediate = (
    resolved: Pick<
      DelegationModelChoiceResolved,
      "reason" | "used" | "outcome" | "resolvedBy" | "effort"
    >,
    suggestions: ReadonlyArray<ModelChoiceOption> = [],
  ): ModelDecision => ({
    kind: "immediate",
    resolved: { choiceId: input.choiceId, requested, fallback: input.trunk, ...resolved },
    suggestions,
  });
  const fallback = (
    reason: ModelChoiceUnusableReason,
    resolvedBy: DelegationModelChoiceResolved["resolvedBy"],
    suggestions: ReadonlyArray<ModelChoiceOption> = [],
  ) =>
    immediate(
      {
        reason,
        used: input.trunk,
        outcome: "fallback",
        resolvedBy,
        ...unapplied(resolvedBy === "disabled" ? "agent-choice-disabled" : "model-not-selected"),
      },
      suggestions,
    );

  const context = input.context;
  if (context === null) return fallback("catalog-unavailable", "server");
  if (context.settings.delegatedThreadModelChoice === "parent") {
    return fallback("agent-choice-disabled", "disabled");
  }
  const resolution =
    requested === null
      ? ({ reason: "invalid-request" } as const)
      : resolveRequested(requested, context, input.trunk);
  if ("selection" in resolution) {
    const configured =
      effort === undefined
        ? { selection: resolution.selection }
        : resolution.ambiguousEffortIdentity && effort.requested !== undefined
          ? {
              selection: resolution.selection,
              effort: { ...effort, reason: "capabilities-unknown" as const },
            }
          : configureDelegatedEffort(effort, context, resolution.selection);
    return immediate({
      reason: null,
      used: configured.selection,
      ...("effort" in configured
        ? { effort: configured.effort satisfies DelegationEffortDecision }
        : {}),
      outcome: "requested",
      resolvedBy: "server",
    });
  }
  const options = withFallbackOption(listRankedUsableModels(context, input.trunk), input.trunk);
  const suggestions = options.slice(0, MODEL_CHOICE_SUGGESTION_LIMIT);
  if (!context.hasInteractiveClient) return fallback(resolution.reason, "no-client", suggestions);
  if (!options.some((option) => !option.isFallback)) {
    return fallback(resolution.reason, "no-alternatives", suggestions);
  }
  return {
    kind: "hold",
    requested: {
      choiceId: input.choiceId,
      delegationId: input.delegationId,
      requested,
      fallback: input.trunk,
      reason: resolution.reason,
      ...unapplied("model-not-selected"),
      options,
      deadlineAt: input.deadlineAt,
      heldMessageId: MessageId.makeUnsafe(input.heldMessageId),
    },
    suggestions,
  };
}
