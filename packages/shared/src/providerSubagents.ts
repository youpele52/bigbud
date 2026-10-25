import { mergeTaskPatch, toBoundedRedactedText } from "./providerRuntime";

/** Display bounds for provider-native subagent fields. Adapters bound before emitting. */
export const PROVIDER_SUBAGENT_LIMITS = {
  subject: 120,
  model: 120,
  effort: 40,
  prompt: 1_000,
  progressSummary: 500,
  resultSummary: 1_000,
  toolName: 80,
  label: 160,
} as const;
export type ProviderSubagentTextField = keyof typeof PROVIDER_SUBAGENT_LIMITS;

/** Mirrors `ORCHESTRATION_SUBAGENT_RECENT_STEPS_MAX` in contracts. */
export const PROVIDER_SUBAGENT_RECENT_STEPS_MAX = 5;

export type ProviderSubagentStepStatus = "running" | "completed" | "failed";

export interface ProviderSubagentStep {
  readonly id?: string;
  readonly toolName: string;
  readonly label?: string;
  readonly status: ProviderSubagentStepStatus;
  readonly at: string;
}

export interface ProviderSubagentStepInput {
  readonly id?: string | undefined;
  readonly toolName: unknown;
  readonly label?: unknown;
  readonly status: ProviderSubagentStepStatus;
  readonly at: string;
}

export interface ProviderSubagentMetrics {
  readonly totalTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
  readonly costUsd?: number;
}

/** Trims, redacts and bounds a provider string; blank or non-string input is absent. */
export function boundSubagentText(
  value: unknown,
  field: ProviderSubagentTextField,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const bounded = toBoundedRedactedText(trimmed, { maxChars: PROVIDER_SUBAGENT_LIMITS[field] });
  return bounded.trim() || undefined;
}

/**
 * Appends a step to the bounded ring. A step whose ID is already present replaces
 * that entry in place, so repeated updates for one tool call stay idempotent.
 */
export function appendSubagentStep(
  steps: ReadonlyArray<ProviderSubagentStep> | undefined,
  input: ProviderSubagentStepInput,
): ReadonlyArray<ProviderSubagentStep> {
  const current = steps ?? [];
  const toolName = boundSubagentText(input.toolName, "toolName");
  if (!toolName) return current;
  const label = boundSubagentText(input.label, "label");
  const id = input.id?.trim() || undefined;
  const step: ProviderSubagentStep = {
    ...(id ? { id } : {}),
    toolName,
    ...(label ? { label } : {}),
    status: input.status,
    at: input.at,
  };
  const existingIndex = id ? current.findIndex((entry) => entry.id === id) : -1;
  if (existingIndex >= 0) {
    const existing = current[existingIndex]!;
    const merged: ProviderSubagentStep = {
      ...step,
      ...(!label && existing.label ? { label: existing.label } : {}),
    };
    return current.map((entry, index) => (index === existingIndex ? merged : entry));
  }
  return [...current, step].slice(-PROVIDER_SUBAGENT_RECENT_STEPS_MAX);
}

/** Marks a known running step as completed or failed. Unknown IDs leave the ring unchanged. */
export function completeSubagentStep<Steps extends ReadonlyArray<ProviderSubagentStep> | undefined>(
  steps: Steps,
  id: string,
  status: Exclude<ProviderSubagentStepStatus, "running">,
): Steps {
  if (!steps) return steps;
  const index = steps.findIndex((entry) => entry.id === id);
  if (index < 0) return steps;
  return steps.map((entry, position) =>
    position === index ? { ...entry, status } : entry,
  ) as unknown as Steps;
}

function nonNegative(value: unknown, integer: boolean): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return integer ? Math.floor(value) : value;
}

/**
 * Keeps only finite, non-negative provider totals. Values missing from `input` fall back
 * to `previous`, so a partial update never erases known metrics. Empty results are absent.
 */
export function normalizeSubagentMetrics(
  input: {
    readonly totalTokens?: unknown;
    readonly toolUses?: unknown;
    readonly durationMs?: unknown;
    readonly costUsd?: unknown;
  },
  previous?: ProviderSubagentMetrics,
): ProviderSubagentMetrics | undefined {
  const totalTokens = nonNegative(input.totalTokens, true) ?? previous?.totalTokens;
  const toolUses = nonNegative(input.toolUses, true) ?? previous?.toolUses;
  const durationMs = nonNegative(input.durationMs, true) ?? previous?.durationMs;
  const costUsd = nonNegative(input.costUsd, false) ?? previous?.costUsd;
  const metrics: ProviderSubagentMetrics = {
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "stopped"]);

/**
 * Merges a durable task snapshot over the stored one. When a newer provider run reopens a
 * terminal task, its stale `endedAt` and `resultSummary` are dropped unless re-supplied.
 */
export function mergeTaskSnapshot<
  T extends {
    readonly status: string;
    readonly endedAt?: string | undefined;
    readonly resultSummary?: string | undefined;
  },
>(existing: T, incoming: T): T {
  const merged = mergeTaskPatch(existing, incoming) as unknown as T;
  if (!TERMINAL_TASK_STATUSES.has(existing.status) || TERMINAL_TASK_STATUSES.has(incoming.status)) {
    return merged;
  }
  const { endedAt: _endedAt, resultSummary: _resultSummary, ...reopened } = merged;
  return {
    ...reopened,
    ...(incoming.endedAt ? { endedAt: incoming.endedAt } : {}),
    ...(incoming.resultSummary ? { resultSummary: incoming.resultSummary } : {}),
  } as T;
}
