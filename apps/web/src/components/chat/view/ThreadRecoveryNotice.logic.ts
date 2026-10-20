import type { ThreadTurnStartRequest } from "../../../models/types/app.types";
import {
  isForkOnlyFailureClass,
  MANUAL_CONTINUE_FAILURE_CLASSES,
  type ServerTurnFailure,
} from "./ThreadRecoveryNotice.failure";

/**
 * UI threshold only, not a timeout: after this long without a started turn the thread shows
 * "Reconnecting…". The server's own start timeout and recovery decide the outcome (plan D15).
 */
export const RECONNECTING_NOTICE_DELAY_MS = 5_000;
/** How long a green/amber outcome stays visible after the turn started. */
export const RECOVERED_NOTICE_VISIBLE_MS = 6_000;

export type ThreadRecoveryNoticeKind = "reconnecting" | "recovered" | "degraded" | "failed";
/** Alert variants per AGENTS.md: blue working, green done, amber warning, red failure. */
export type ThreadRecoveryNoticeTone = "info" | "success" | "warning" | "error";

export interface ThreadRecoveryNotice {
  readonly kind: ThreadRecoveryNoticeKind;
  readonly tone: ThreadRecoveryNoticeTone;
  readonly title: string;
  readonly description: string;
  /** Offer "Continue in a new thread" (server-side fork) while waiting or after a failure. */
  readonly canContinueInNewThread: boolean;
}

export interface ThreadRecoveryNoticeDerivation {
  readonly notice: ThreadRecoveryNotice | null;
  /** Milliseconds until the derived notice can change without new input, if ever. */
  readonly nextChangeInMs: number | null;
}

/**
 * When this browser first saw a request and its settlement. Every duration is measured on this
 * one clock; server and command timestamps are never subtracted from the browser's time (D21).
 */
export interface TurnStartRequestClock {
  readonly requestKey: string;
  readonly observedAtMs: number;
  readonly settledObservedAtMs: number | null;
}

/** Keeps the first observation of a request, and records its settlement once. */
export function observeTurnStartRequest(
  previous: TurnStartRequestClock | undefined,
  request: ThreadTurnStartRequest | null | undefined,
  nowMs: number,
): TurnStartRequestClock | null {
  if (!request) return null;
  const requestKey = `${request.messageId}\0${request.requestedAt}`;
  const current =
    previous?.requestKey === requestKey
      ? previous
      : { requestKey, observedAtMs: nowMs, settledObservedAtMs: null };
  if (request.outcome === "pending" || current.settledObservedAtMs !== null) return current;
  return { ...current, settledObservedAtMs: nowMs };
}

const NOTICE_TONES: Record<ThreadRecoveryNoticeKind, ThreadRecoveryNoticeTone> = {
  reconnecting: "info",
  recovered: "success",
  degraded: "warning",
  failed: "error",
};

const notice = (kind: ThreadRecoveryNoticeKind, description: string): ThreadRecoveryNotice => ({
  kind,
  tone: NOTICE_TONES[kind],
  title: {
    reconnecting: "Reconnecting…",
    recovered: "Reconnected",
    degraded: "Continued in a fresh session",
    failed: "Could not reconnect",
  }[kind],
  description,
  canContinueInNewThread: kind === "reconnecting" || kind === "failed",
});

const failedNotice = (failureClass: string): ThreadRecoveryNoticeDerivation => ({
  notice: notice(
    "failed",
    failureClass === "provider-unavailable"
      ? "The provider is not available (not installed, not executable, or disabled). Fix it in Settings, or continue in a new thread."
      : failureClass === "unsafe-to-replay"
        ? "This turn could not be safely resumed automatically. Review and resolve the error above before sending again or continuing in a new thread."
        : isForkOnlyFailureClass(failureClass)
          ? "This thread's provider session cannot be resumed. Continue in a new thread to keep working."
          : failureClass === "invalid-request"
            ? "The provider rejected this request (for example, the model is no longer offered). See the error above, or continue in a new thread and pick another model."
            : "The turn did not start. See the error above for details.",
  ),
  nextChangeInMs: null,
});

/**
 * Pure state machine for the thread's reconnecting notice. A live request drives the blue and
 * green states; a failure comes from server state, so a fork-only failure survives a reload.
 */
export function deriveThreadRecoveryNotice(input: {
  readonly request: ThreadTurnStartRequest | null | undefined;
  readonly clock: TurnStartRequestClock | null;
  readonly failure: ServerTurnFailure | null;
  readonly nowMs: number;
}): ThreadRecoveryNoticeDerivation {
  const { request, failure, nowMs } = input;
  const steps = request?.recoverySteps ?? [];
  const observedAtMs = input.clock?.observedAtMs ?? nowMs;
  const settledAtMs = input.clock?.settledObservedAtMs ?? nowMs;
  const waitedMs = settledAtMs - observedAtMs;
  const slow = steps.length > 0 || waitedMs >= RECONNECTING_NOTICE_DELAY_MS;

  if (request?.outcome === "pending") {
    if (!slow) {
      return { notice: null, nextChangeInMs: RECONNECTING_NOTICE_DELAY_MS - waitedMs };
    }
    const latest = steps.at(-1);
    const description =
      latest?.step === "fresh-replay"
        ? "Starting a fresh provider session and replaying this conversation as text."
        : latest?.step === "revive"
          ? "Reconnecting to the provider session."
          : "The provider has not started this turn yet; waiting for it to respond.";
    return { notice: notice("reconnecting", description), nextChangeInMs: null };
  }
  const retried = request?.outcome === "started" && request.messageId === failure?.pendingMessageId;
  if ((failure !== null && !retried) || request?.outcome === "failed") {
    const failureClass = retried ? "" : (failure?.failureClass ?? "");
    const shown =
      MANUAL_CONTINUE_FAILURE_CLASSES.has(failureClass) || (request?.outcome === "failed" && slow);
    return shown ? failedNotice(failureClass) : { notice: null, nextChangeInMs: null };
  }
  if (!request || !slow) return { notice: null, nextChangeInMs: null };
  const remainingMs = settledAtMs + RECOVERED_NOTICE_VISIBLE_MS - nowMs;
  if (remainingMs <= 0) return { notice: null, nextChangeInMs: null };
  const degraded = steps.some(
    (entry) => entry.step === "fresh-replay" && entry.outcome === "succeeded",
  );
  return {
    notice: degraded
      ? notice(
          "degraded",
          "The provider session was lost. Earlier messages were replayed as text into a new session.",
        )
      : notice("recovered", "The turn has started."),
    nextChangeInMs: remainingMs,
  };
}
