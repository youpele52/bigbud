import * as Schema from "effect/Schema";

export const THREAD_RETENTION_POLICIES = [
  "1-day",
  "2-days",
  "3-days",
  "7-days",
  "14-days",
  "30-days",
  "90-days",
  "never",
] as const;

export const FINITE_THREAD_RETENTION_POLICIES = [
  "1-day",
  "2-days",
  "3-days",
  "7-days",
  "14-days",
  "30-days",
  "90-days",
] as const;

export const THREAD_RETENTION_POLICY_LABELS = {
  "1-day": "1 day",
  "2-days": "2 days",
  "3-days": "3 days",
  "7-days": "7 days",
  "14-days": "14 days",
  "30-days": "30 days",
  "90-days": "90 days",
  never: "Never",
} as const;

export const ThreadRetentionPolicy = Schema.Literals(THREAD_RETENTION_POLICIES);
export type ThreadRetentionPolicy = typeof ThreadRetentionPolicy.Type;

export const FiniteThreadRetentionPolicy = Schema.Literals(FINITE_THREAD_RETENTION_POLICIES);
export type FiniteThreadRetentionPolicy = typeof FiniteThreadRetentionPolicy.Type;

export const THREAD_RETENTION_POLICY_DURATIONS_MS = {
  "1-day": 1 * 24 * 60 * 60 * 1_000,
  "2-days": 2 * 24 * 60 * 60 * 1_000,
  "3-days": 3 * 24 * 60 * 60 * 1_000,
  "7-days": 7 * 24 * 60 * 60 * 1_000,
  "14-days": 14 * 24 * 60 * 60 * 1_000,
  "30-days": 30 * 24 * 60 * 60 * 1_000,
  "90-days": 90 * 24 * 60 * 60 * 1_000,
} as const satisfies Record<FiniteThreadRetentionPolicy, number>;
