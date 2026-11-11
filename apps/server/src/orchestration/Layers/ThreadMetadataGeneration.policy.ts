import { createHash } from "node:crypto";

import type {
  MetadataGenerationAttemptState,
  MetadataGenerationJobState,
  MetadataGenerationStage,
} from "@bigbud/contracts/orchestration/orchestration.metadataGeneration.ts";
import type { ModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider";

export const METADATA_GENERATION_LIMITS = {
  primaryAttempts: 2,
  threadModelAttempts: 1,
  retryDelaysMs: [2_000],
  dispatchDeadlineMs: 180_000,
  verifiedModelWaitMs: 1_800_000,
  /** Retained only for the historical NOT NULL database column. Never an execution window. */
  nativeWaitMs: 0,
  jobDeadlineMs: 1_800_000,
} as const;

/** Attempt evidence survives jobs, activity-tail truncation, and owner lease expiry. */
export interface MetadataAttemptEvidence {
  readonly stage: MetadataGenerationStage;
  readonly state: MetadataGenerationAttemptState;
  readonly executionFingerprint: string;
}

export const metadataJobIsTerminal = (state: MetadataGenerationJobState): boolean =>
  state === "completed" ||
  state === "stale" ||
  state === "cancelled" ||
  state === "exhausted" ||
  state === "unavailable" ||
  state === "quarantined";

export const metadataAttemptBlocksReplay = (state: MetadataGenerationAttemptState): boolean =>
  state === "dispatch-intent" ||
  state === "acknowledged" ||
  state === "uncertain" ||
  state === "result-ready";

/** Stable object key ordering, preserving array order and all model options. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

/** Account/endpoint identity must be an opaque identifier, never credential material. */
export interface MetadataExecutionPath {
  readonly selection: ModelSelection;
  readonly transport: string;
  readonly accountIdentity: string;
  readonly executionTarget: string;
  readonly promptVersion: string;
  readonly validatorVersion: string;
  readonly mode: "auxiliary" | "native";
}

export function metadataFingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export const metadataExecutionFingerprint = (path: MetadataExecutionPath): string =>
  metadataFingerprint(path);

export type MetadataNextAction =
  | { readonly type: "reconcile" }
  | { readonly type: "commit-result" }
  | {
      readonly type: "attempt";
      readonly stage: "primary" | "thread-model";
      readonly ordinal: number;
    }
  | { readonly type: "wait-model" }
  | { readonly type: "terminal"; readonly state: MetadataGenerationJobState };

/** Pure policy: each row is ONE application dispatch, never an outer candidate list. */
export function nextMetadataAction(input: {
  readonly state: MetadataGenerationJobState;
  readonly attempts: ReadonlyArray<MetadataAttemptEvidence>;
  readonly now: number;
  readonly deadline: number;
  readonly modelWaitUntil: number;
  readonly primaryFingerprint: string | null;
  readonly threadModelFingerprint: string | null;
}): MetadataNextAction {
  if (input.attempts.some((attempt) => attempt.stage === "native"))
    return input.attempts.some((attempt) => metadataAttemptBlocksReplay(attempt.state))
      ? { type: "reconcile" }
      : { type: "terminal", state: "quarantined" };
  if (input.attempts.some((attempt) => attempt.state === "result-ready"))
    return { type: "commit-result" };
  if (input.attempts.some((attempt) => metadataAttemptBlocksReplay(attempt.state)))
    return { type: "reconcile" };
  if (metadataJobIsTerminal(input.state)) return { type: "terminal", state: input.state };
  for (const state of ["completed", "stale", "cancelled"] as const) {
    if (input.attempts.some((attempt) => attempt.state === state))
      return { type: "terminal", state };
  }
  if (input.now >= input.deadline) return { type: "terminal", state: "exhausted" };
  // A prepared attempt has never crossed the dispatch fence. Resume it, with the SAME identity.
  const prepared = input.attempts.find((attempt) => attempt.state === "prepared");
  // Older captures could mislabel a no-override thread path as primary. Keep their evidence,
  // but never resume that obsolete budget. Possibly dispatched work was fenced above.
  if (
    prepared &&
    prepared.stage === "primary" &&
    (!input.primaryFingerprint ||
      input.attempts.filter((attempt) => attempt.stage === "primary").length >
        METADATA_GENERATION_LIMITS.primaryAttempts)
  )
    return { type: "terminal", state: "quarantined" };
  if (prepared)
    return {
      type: "attempt",
      stage: prepared.stage as "primary" | "thread-model",
      ordinal: input.attempts.filter((attempt) => attempt.stage === prepared.stage).length,
    };
  const primary = input.attempts.filter((attempt) => attempt.stage === "primary");
  const primaryStopped = primary.some((attempt) => attempt.state !== "failed");
  if (
    input.primaryFingerprint &&
    !primaryStopped &&
    primary.length < METADATA_GENERATION_LIMITS.primaryAttempts
  )
    return { type: "attempt", stage: "primary", ordinal: primary.length + 1 };
  const threadAttempts = input.attempts.filter((attempt) => attempt.stage === "thread-model");
  const duplicate = primary.some(
    (attempt) =>
      attempt.state === "failed" && attempt.executionFingerprint === input.threadModelFingerprint,
  );
  if (input.threadModelFingerprint && threadAttempts.length === 0 && !duplicate)
    return { type: "attempt", stage: "thread-model", ordinal: 1 };
  if (
    !input.threadModelFingerprint &&
    threadAttempts.length === 0 &&
    input.now < input.modelWaitUntil
  )
    return { type: "wait-model" };
  return { type: "terminal", state: input.threadModelFingerprint ? "exhausted" : "unavailable" };
}

/** Never pool unrelated jobs' failures or describe an unavailable path as paid failures. */
export const metadataWarningRequired = (
  configuredPrimary: boolean,
  attempts: ReadonlyArray<MetadataAttemptEvidence>,
  primaryAvailable = true,
): boolean =>
  configuredPrimary &&
  (!primaryAvailable ||
    attempts.some((attempt) => attempt.stage === "primary" && attempt.state === "unavailable") ||
    attempts.filter((attempt) => attempt.stage === "primary" && attempt.state === "failed")
      .length >= METADATA_GENERATION_LIMITS.primaryAttempts);
