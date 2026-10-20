import { Schema } from "effect";
import {
  ModelSelection,
  type ProviderKind,
} from "@bigbud/contracts/orchestration/orchestration.provider";

export const INTERNAL_TEXT_GENERATION_OPERATIONS = [
  "generateCommitMessage",
  "generatePrContent",
  "generateBranchName",
  "generateThreadTitle",
  "generateThreadElevatorSummary",
  "generatePromptSuggestion",
] as const;
export type InternalTextGenerationOperation = (typeof INTERNAL_TEXT_GENERATION_OPERATIONS)[number];

/** Global overrides must implement every operation; title-only integrations remain title-only. */
export const FULL_TEXT_GENERATION_PROVIDERS: ReadonlyArray<ProviderKind> = [
  "codex",
  "claudeAgent",
  "cursor",
  "opencodeV2",
];

export function supportsInternalTextGeneration(
  provider: ProviderKind,
  operation: InternalTextGenerationOperation,
): boolean {
  return (
    FULL_TEXT_GENERATION_PROVIDERS.includes(provider) ||
    (operation === "generateThreadTitle" && (provider === "pi" || provider === "copilot"))
  );
}

export const USER_TURN_BOUND = "text-generation.user-turn-bound";
export const MODEL_SUCCEEDED = "text-generation.model-succeeded";

/** An unresolved paid job (including a restart-surviving claim) cannot authorize new generation. */
export function hasTextGenerationUncertainty(
  activities: ReadonlyArray<Activity>,
  operation: string,
  turnId?: string,
): boolean {
  const latest = activities.findLast((activity) => {
    const payload = activity.payload as { operation?: unknown; turnId?: unknown } | null;
    return (
      [
        "text-generation.started",
        "text-generation.uncertain",
        "text-generation.failed",
        "text-generation.completed",
      ].includes(activity.kind) &&
      payload?.operation === operation &&
      (turnId === undefined || payload.turnId === turnId)
    );
  });
  return (
    latest?.kind === "text-generation.uncertain" ||
    (latest?.kind === "text-generation.started" &&
      (latest.payload as { uncertaintyProtected?: unknown } | null)?.uncertaintyProtected === true)
  );
}

interface Activity {
  readonly kind: string;
  readonly turnId: string | null;
  readonly payload: unknown;
}

/** Only distinct persisted user submissions with verified completion count; metadata jobs never bind. */
export function successfulUserTurns(activities: ReadonlyArray<Activity>) {
  const bindings = new Map<string, string>();
  for (const activity of activities) {
    if (activity.kind !== USER_TURN_BOUND || !activity.turnId) continue;
    const payload = activity.payload as { messageId?: unknown } | null;
    if (typeof payload?.messageId === "string") bindings.set(activity.turnId, payload.messageId);
  }
  const seen = new Set<string>();
  const turns: Array<{ messageId: string; turnId: string; model: ModelSelection }> = [];
  for (const activity of activities) {
    if (
      activity.kind !== MODEL_SUCCEEDED ||
      !activity.turnId ||
      !Schema.is(ModelSelection)(activity.payload)
    )
      continue;
    const messageId = bindings.get(activity.turnId);
    if (!messageId || seen.has(messageId)) continue;
    seen.add(messageId);
    turns.push({ messageId, turnId: activity.turnId, model: activity.payload });
  }
  return turns;
}
