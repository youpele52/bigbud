import type { TraceRecord } from "./TraceRecord.ts";
import { Schema } from "effect";

/** Controls how much of the local trace stream is retained on disk. */
export type TraceMode = "production" | "diagnostic" | "all";
export const TraceModeSchema = Schema.Literals(["production", "diagnostic", "all"]);

export interface TracePolicy {
  /** Production drops fast successful spans; diagnostic retains them. */
  readonly mode: TraceMode;
  /** Deterministic sample rate for successful spans below the slow threshold. */
  readonly successSampleRate?: number;
  readonly slowSpanMs?: number;
  readonly slowSqlSpanMs?: number;
  /** Optional expiry for temporary diagnostic capture. */
  readonly expiresAtMs?: number;
}

export const DEFAULT_TRACE_POLICY: TracePolicy = {
  mode: "production",
  successSampleRate: 0,
  slowSpanMs: 500,
  slowSqlSpanMs: 100,
};

const clampSampleRate = (value: number): number => Math.min(1, Math.max(0, value));

const hasErrorEvent = (record: {
  readonly events: ReadonlyArray<{
    readonly name: string;
    readonly attributes: Readonly<Record<string, unknown>>;
  }>;
}): boolean =>
  record.events.some((event) => {
    const level = event.attributes["effect.logLevel"];
    return level === "ERROR" || level === "FATAL" || event.name === "error";
  });

const hasErrorStatus = (record: TraceRecord): boolean => {
  if (record.type === "effect-span") {
    return record.exit._tag !== "Success" || hasErrorEvent(record);
  }

  const statusCode = record.status?.code?.toUpperCase();
  return (
    statusCode === "2" ||
    statusCode === "STATUS_CODE_ERROR" ||
    statusCode?.includes("ERROR") === true ||
    hasErrorEvent(record)
  );
};

const stableSample = (record: TraceRecord, sampleRate: number): boolean => {
  if (sampleRate <= 0) {
    return false;
  }
  if (sampleRate >= 1) {
    return true;
  }

  let hash = 2166136261;
  for (const character of `${record.traceId}:${record.spanId}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4_294_967_296 < sampleRate;
};

/**
 * Applies a tail decision after a span has ended. Errors and slow operations
 * are retained regardless of the success sample rate; fast successful SQL is
 * therefore absent from the normal production trace file.
 */
export const shouldPersistTraceRecord = (
  record: TraceRecord,
  policy: TracePolicy = DEFAULT_TRACE_POLICY,
): boolean => {
  if (policy.mode === "all") {
    return true;
  }
  if (
    policy.mode === "diagnostic" &&
    (policy.expiresAtMs === undefined || Date.now() < policy.expiresAtMs)
  ) {
    return true;
  }
  if (hasErrorStatus(record)) {
    return true;
  }

  const isSql = record.name === "sql.execute" || record.name === "sql.transaction";
  const threshold = isSql
    ? (policy.slowSqlSpanMs ?? DEFAULT_TRACE_POLICY.slowSqlSpanMs ?? 100)
    : (policy.slowSpanMs ?? DEFAULT_TRACE_POLICY.slowSpanMs ?? 500);
  if (record.durationMs >= threshold) {
    return true;
  }

  return stableSample(record, clampSampleRate(policy.successSampleRate ?? 0));
};

/** Builds the single policy gate shared by local and browser trace ingestion. */
export const makeTraceRecordRecorder =
  (
    push: (record: TraceRecord) => void,
    policy: TracePolicy = DEFAULT_TRACE_POLICY,
    onDecision?: (decision: "retained" | "dropped", record: TraceRecord) => void,
  ) =>
  (record: TraceRecord): void => {
    const retained = shouldPersistTraceRecord(record, policy);
    onDecision?.(retained ? "retained" : "dropped", record);
    if (retained) {
      push(record);
    }
  };
