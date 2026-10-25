/**
 * Pure recovery policy: given what is known about one intent after a sleep, what to do next.
 *
 * The invariant is: reconcile before continuing; never blindly replay potentially accepted
 * work. Every branch that could send something first checks that the provider is not still
 * working, that the turn did not finish, and that no tool may have been running.
 *
 * @module ProviderTurnSupervisor.policy.logic
 */
import type {
  ThreadRecovery,
  ThreadRecoveryReason,
} from "@bigbud/contracts/orchestration/orchestration.recovery.ts";

import type { ThreadRecoveryIntent } from "../../persistence/Services/ThreadRecoveryIntents.ts";

/** Automatic continuation attempts before the intent parks with a Retry button. */
export const RECOVERY_MAX_ATTEMPTS = 3;
/** Awake time with no progress and no terminal event before "No activity since wake". */
export const RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS = 120_000;
/** Progress received this soon after wake may have been buffered before the sleep. */
export const RECOVERY_PROGRESS_SETTLE_MS = 3_000;

export type InspectionOutcome =
  | "running"
  | "waiting-for-user"
  | "completed"
  | "failed"
  | "missing"
  | "unavailable";

export interface RecoveryFacts {
  readonly intent: ThreadRecoveryIntent;
  readonly nowMs: number;
  /** When the sleep this intent is recovering from ended. */
  readonly wokeAtMs: number | null;
  readonly inspection: InspectionOutcome | null;
  /** Meaningful provider progress received after wake, without a bigbud continuation. */
  readonly progressAfterWake: boolean;
  /** When the provider produced its latest meaningful progress (the event's own time), or null. */
  readonly lastProgressAtMs: number | null;
  readonly turnCompleted: boolean;
  /** Summary of the tool(s) that may have been running, or null. */
  readonly toolInFlight: string | null;
  /** Latest desktop network state; null when unknown (treated as online). */
  readonly networkOnline: boolean | null;
  /** False when `BIGBUD_SLEEP_CONTINUATION=0`. */
  readonly continuationEnabled: boolean;
  /** No active turn bound, no pending start, nothing awaiting approval. */
  readonly threadIdle: boolean;
  /** The thread has a pending approval or user-input request: the turn waits for the user. */
  readonly waitingForUser: boolean;
}

export type RecoveryDecision =
  | { readonly type: "none" }
  | { readonly type: "settle" }
  | { readonly type: "provider-continued" }
  | { readonly type: "wait-network" }
  | { readonly type: "continue" }
  | { readonly type: "park" }
  | {
      readonly type: "await-user";
      readonly reason: ThreadRecoveryReason;
      readonly toolSummary: string | null;
    };

const providerStillWorking = (facts: RecoveryFacts) =>
  facts.inspection === "running" ||
  facts.inspection === "waiting-for-user" ||
  facts.progressAfterWake;

const finished = (facts: RecoveryFacts) => facts.turnCompleted || facts.inspection === "completed";

const awakeMs = (facts: RecoveryFacts) =>
  facts.wokeAtMs === null ? 0 : Math.max(0, facts.nowMs - facts.wokeAtMs);

/** The turn was cut: a terminal failure arrived inside a sleep window. */
function decideCut(facts: RecoveryFacts): RecoveryDecision {
  if (finished(facts)) return { type: "settle" };
  if (providerStillWorking(facts)) return { type: "provider-continued" };
  // The user chose Continue, Retry or Stop and continue: they already saw the uncertainty.
  if (facts.intent.detail.userAuthorized !== true) {
    if (facts.toolInFlight !== null) {
      return { type: "await-user", reason: "tool-in-flight", toolSummary: facts.toolInFlight };
    }
    if (!facts.continuationEnabled) {
      return { type: "await-user", reason: "interrupted-by-sleep", toolSummary: null };
    }
    if (facts.intent.attemptCount >= RECOVERY_MAX_ATTEMPTS) return { type: "park" };
  }
  // Waiting for the network or for the thread to settle is not an attempt. Neither waits
  // forever: a missed "online" hint or a stuck thread asks the user after the same 120 s.
  const blocked = facts.networkOnline === false || !facts.threadIdle;
  if (blocked && awakeMs(facts) >= RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS) {
    return { type: "await-user", reason: "interrupted-by-sleep", toolSummary: null };
  }
  if (facts.networkOnline === false) return { type: "wait-network" };
  if (!facts.threadIdle) return { type: "none" };
  return { type: "continue" };
}

/** The turn was running across the sleep and nothing terminal arrived yet. */
function decideObserving(facts: RecoveryFacts): RecoveryDecision {
  if (finished(facts)) return { type: "settle" };
  // A turn waiting for an approval or an answer is the provider still working, not silence.
  if (providerStillWorking(facts) || facts.waitingForUser) return { type: "provider-continued" };
  if (awakeMs(facts) >= RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS) {
    return {
      type: "await-user",
      reason: "no-activity-after-wake",
      toolSummary: facts.toolInFlight,
    };
  }
  return { type: "none" };
}

/**
 * The provider continued on its own. It settles when the turn finishes. A thread that went idle
 * without a completion asks the user after 120 s of quiet, counted from wake or the latest
 * progress: something ended the turn unseen, and nothing is ever sent from this state.
 */
function decideProviderContinued(facts: RecoveryFacts): RecoveryDecision {
  if (finished(facts)) return { type: "settle" };
  if (!facts.threadIdle) return { type: "none" };
  if (facts.inspection === "running" || facts.inspection === "waiting-for-user") {
    return { type: "none" };
  }
  const quietSinceMs = Math.max(facts.wokeAtMs ?? facts.nowMs, facts.lastProgressAtMs ?? 0);
  if (facts.nowMs - quietSinceMs < RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS) return { type: "none" };
  return { type: "await-user", reason: "interrupted-by-sleep", toolSummary: null };
}

export function decideRecovery(facts: RecoveryFacts): RecoveryDecision {
  if (facts.intent.disposition !== "active") return { type: "none" };
  switch (facts.intent.recoveryStatus) {
    case "interrupted-by-sleep":
      return decideCut(facts);
    case "observing":
      return decideObserving(facts);
    case "provider-continued":
      return decideProviderContinued(facts);
    case "awaiting-user":
      if (finished(facts)) return { type: "settle" };
      return facts.intent.detail.reason === "no-activity-after-wake" && providerStillWorking(facts)
        ? { type: "provider-continued" }
        : { type: "none" };
    default:
      return { type: "none" };
  }
}

/** Whether progress received at `receivedAtMs` counts as "after wake". */
export function isProgressAfterWake(receivedAtMs: number | null, wokeAtMs: number | null): boolean {
  return (
    receivedAtMs !== null &&
    wokeAtMs !== null &&
    receivedAtMs >= wokeAtMs + RECOVERY_PROGRESS_SETTLE_MS
  );
}

/** The thread's visible recovery state for an intent, or null when nothing is shown. */
export function toThreadRecovery(
  intent: ThreadRecoveryIntent,
  updatedAt: string,
): ThreadRecovery | null {
  switch (intent.recoveryStatus) {
    case "interrupted-by-sleep":
    case "continuing":
    case "awaiting-user":
    case "parked":
    case "provider-continued":
      return {
        status: intent.recoveryStatus,
        reason: intent.detail.reason ?? null,
        toolSummary: intent.detail.toolSummary ?? null,
        // Every try, automatic or the user's, so each one is its own visible state. Parking
        // counts automatic attempts only (`attemptCount`).
        attempt: intent.attemptCount + (intent.detail.userAttemptCount ?? 0),
        provider: intent.provider,
        messageId: intent.messageId,
        updatedAt,
      };
    default:
      return null;
  }
}

/** Two recovery states that render identically. */
export function sameThreadRecovery(
  left: ThreadRecovery | null | undefined,
  right: ThreadRecovery | null,
): boolean {
  if (left == null || right === null) return (left ?? null) === right;
  return (
    left.status === right.status &&
    left.reason === right.reason &&
    left.toolSummary === right.toolSummary &&
    left.attempt === right.attempt &&
    left.provider === right.provider &&
    left.messageId === right.messageId
  );
}
