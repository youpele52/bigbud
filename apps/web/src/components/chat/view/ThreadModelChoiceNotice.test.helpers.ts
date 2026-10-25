import type { OrchestrationThreadActivity } from "@bigbud/contracts";
import type {
  DelegationModelChoiceRequested,
  DelegationModelChoiceResolved,
  ModelChoiceOption,
} from "@bigbud/contracts/orchestration/orchestration.delegationModelChoice";

export const TRUNK_SELECTION = { provider: "codex", model: "gpt-5" } as const;

const option = (index: number): ModelChoiceOption => ({
  selection: { provider: "codex", model: `gpt-extra-${index}` },
  label: `GPT Extra ${index}`,
  providerLabel: "Codex",
  lastUsedAt: null,
  isFallback: false,
});

/** A pending choice: the trunk's model first, one Claude model, then `extra` Codex models. */
export function makeRequestedPayload(
  overrides: Partial<DelegationModelChoiceRequested> & { readonly extra?: number } = {},
): DelegationModelChoiceRequested {
  const { extra = 0, ...rest } = overrides;
  return {
    choiceId: "choice-1",
    delegationId: "delegation-1",
    requested: { provider: "cursor", model: "composer-1" },
    fallback: TRUNK_SELECTION,
    reason: "provider-hidden",
    options: [
      {
        selection: TRUNK_SELECTION,
        label: "GPT-5",
        providerLabel: "Codex",
        lastUsedAt: null,
        isFallback: true,
      },
      {
        selection: { provider: "claudeAgent", model: "claude-sonnet" },
        label: "Claude Sonnet",
        providerLabel: "Claude",
        lastUsedAt: "2026-10-15T09:00:00.000Z",
        isFallback: false,
      },
      ...Array.from({ length: extra }, (_, index) => option(index + 1)),
    ],
    deadlineAt: "2026-10-15T10:00:10.000Z",
    heldMessageId: "message-1" as never,
    ...rest,
  };
}

export function makeResolvedPayload(
  overrides: Partial<DelegationModelChoiceResolved> = {},
): DelegationModelChoiceResolved {
  return {
    choiceId: "choice-1",
    requested: { provider: "cursor", model: "composer-1" },
    fallback: TRUNK_SELECTION,
    reason: "provider-hidden",
    used: TRUNK_SELECTION,
    outcome: "fallback",
    resolvedBy: "timeout",
    ...overrides,
  };
}

export function modelChoiceActivity(
  kind: "requested" | "resolved",
  payload: DelegationModelChoiceRequested | DelegationModelChoiceResolved,
  createdAt = "2026-10-15T10:00:00.000Z",
): OrchestrationThreadActivity {
  return {
    id: `${payload.choiceId}:${kind}`,
    tone: "info",
    kind: `delegation.model-choice-${kind}`,
    summary: kind === "requested" ? "Choose a model" : "Model chosen",
    payload,
    turnId: null,
    createdAt,
  } as unknown as OrchestrationThreadActivity;
}
