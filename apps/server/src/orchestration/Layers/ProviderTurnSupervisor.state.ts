/**
 * Shared context and bounded in-memory state of the recovery coordinator.
 *
 * Durable state lives in `thread_recovery_intents`. Memory holds only short-lived evidence:
 * failures awaiting a sleep epoch, the last progress per thread, and inspection throttling.
 * Losing it on restart is safe; a restart has its own handling.
 *
 * @module ProviderTurnSupervisor.state
 */
import type { MessageId, ThreadId } from "@bigbud/contracts";
import type { Effect, Option } from "effect";

import type { ProviderDispatchAttemptRepositoryShape } from "../../persistence/Services/ProviderDispatchAttempts.ts";
import type { ThreadRecoveryIntentRepositoryShape } from "../../persistence/Services/ThreadRecoveryIntents.ts";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import type { SystemSleepEpochsShape } from "../../system-sleep/Services/SystemSleepEpochs.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import type { TurnFailureObservation } from "./ProviderTurnSupervisor.classify.logic.ts";
import type { InspectionOutcome } from "./ProviderTurnSupervisor.policy.logic.ts";
import type { TurnToolTracking } from "./ProviderTurnSupervisor.tools.logic.ts";

/** A failure of an intent's running turn, waiting for sleep evidence. */
export interface PendingTurnFailure {
  readonly observation: TurnFailureObservation;
  /** The intent the failure was observed for; another intent never inherits it. */
  readonly messageId: MessageId;
  /** Awake time held so far, and when it was last counted. */
  heldMs: number;
  lastCheckedAtMs: number;
}

/** A failure waits this much awake time for a sleep epoch to explain it before it is ordinary. */
export const PENDING_FAILURE_GRACE_MS = 30_000;
/**
 * The longest step one check adds to a pending failure's held time. A larger gap between
 * checks is the machine sleeping (the tick runs every 5 s), so a failure observed just before
 * suspend still waits for the epoch that arrives after wake.
 */
export const PENDING_FAILURE_MAX_STEP_MS = 10_000;
/** Bounds on in-memory evidence. */
export const MAX_PENDING_FAILURES = 256;
export const MAX_TRACKED_THREADS = 1_024;
/** One inspection per intent per this interval. */
export const RECOVERY_INSPECTION_INTERVAL_MS = 15_000;
export const RECOVERY_INSPECTION_TIMEOUT_MS = 10_000;
/** How long Stop and continue waits for the provider session to stop before asking again. */
export const RECOVERY_STOP_SESSION_TIMEOUT_MS = 10_000;

export interface RecoveryMemory {
  /** Failures of running turns with an active intent, not yet classified. */
  readonly pendingFailures: Map<ThreadId, PendingTurnFailure>;
  /** Wall time the coordinator last received meaningful progress for a thread. */
  readonly lastProgressAtMs: Map<ThreadId, number>;
  /** Wall time a thread's turn last completed normally. */
  readonly lastCompletedAtMs: Map<ThreadId, number>;
  /** Inspection results; one is valid only for the intent revision it was taken at. */
  readonly inspections: Map<
    string,
    {
      readonly atMs: number;
      readonly revision: number;
      readonly outcome: InspectionOutcome | null;
    }
  >;
  /** Each thread's current turn and its open tool items, from the provider runtime stream. */
  readonly turnTools: Map<ThreadId, TurnToolTracking>;
  /** Notices whose `thread.recovery.set` failed; each recovery pass publishes them again. */
  readonly unpublishedNotices: Map<string, RecoveryNoticeKey>;
}

export interface RecoveryNoticeKey {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}

export function makeRecoveryMemory(): RecoveryMemory {
  return {
    pendingFailures: new Map(),
    lastProgressAtMs: new Map(),
    lastCompletedAtMs: new Map(),
    inspections: new Map(),
    turnTools: new Map(),
    unpublishedNotices: new Map(),
  };
}

/** Sets a key, evicting the oldest entries beyond `limit`. */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

export function intentKeyString(threadId: ThreadId, messageId: MessageId): string {
  return `${threadId}\u0000${messageId}`;
}

/**
 * Drops a thread's short-lived evidence. Failed notices are kept unless `withNotices`: a
 * notice that could not be cleared must still be retried after its turn ended.
 */
export function forgetThreadMemory(
  memory: RecoveryMemory,
  threadId: ThreadId,
  options: { readonly withNotices?: boolean } = {},
): void {
  memory.pendingFailures.delete(threadId);
  memory.lastProgressAtMs.delete(threadId);
  memory.lastCompletedAtMs.delete(threadId);
  memory.turnTools.delete(threadId);
  const prefix = `${threadId}\u0000`;
  const keyed: Array<Map<string, unknown>> = options.withNotices
    ? [memory.inspections, memory.unpublishedNotices]
    : [memory.inspections];
  for (const map of keyed) {
    for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key);
  }
}

export interface RecoveryContext {
  readonly engine: OrchestrationEngineShape;
  readonly providerService: ProviderServiceShape;
  readonly intents: ThreadRecoveryIntentRepositoryShape;
  readonly attempts: Option.Option<ProviderDispatchAttemptRepositoryShape>;
  readonly sleep: Option.Option<SystemSleepEpochsShape>;
  /** False when `BIGBUD_SLEEP_CONTINUATION=0`: classify and prompt, never send on our own. */
  readonly continuationEnabled: boolean;
  readonly nowMs: () => number;
  readonly memory: RecoveryMemory;
  /**
   * Runs a provider call with the coordinator's permit released, then takes the permit back,
   * so a slow provider never holds up event observation. The caller re-reads the intent and
   * compares its revision before acting on the result. Tests run the call inline.
   */
  readonly outsidePermit: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
}

/** `BIGBUD_SLEEP_CONTINUATION=0` disables automatic continuation. On by default. */
export function readSleepContinuationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.BIGBUD_SLEEP_CONTINUATION?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off");
}
