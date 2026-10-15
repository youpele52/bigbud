import type { ThreadTurnStartRequest } from "../../../models/types/app.types";

/**
 * UI threshold only, not a timeout: after this long without a started turn the thread shows
 * "Reconnecting…". The server's own start timeout and recovery decide the outcome (plan D15).
 */
export const RECONNECTING_NOTICE_DELAY_MS = 5_000;
/** How long a green/amber outcome stays visible after the turn started. */
export const RECOVERED_NOTICE_VISIBLE_MS = 6_000;
export const PROVIDER_SESSION_RECOVERY_ACTIVITY_KIND = "provider.session.recovery";
export const TURN_START_FAILED_ACTIVITY_KIND = "provider.turn.start.failed";
/** Failure classes in-place recovery cannot fix; only a new thread continues (plan D16). */
const FORK_ONLY_FAILURE_CLASSES = new Set([
  "session-dead",
  "unsafe-to-replay",
  "provider-unavailable",
]);

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

interface RecoveryActivity {
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt: string;
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

const failureClassOf = (activity: RecoveryActivity | undefined) => {
  const payload = activity?.payload as { failureClass?: unknown } | null | undefined;
  return typeof payload?.failureClass === "string" ? payload.failureClass : undefined;
};

const recoveryStep = (activity: RecoveryActivity) => {
  const payload = activity.payload as { step?: unknown; outcome?: unknown } | null;
  return {
    step: typeof payload?.step === "string" ? payload.step : undefined,
    outcome: typeof payload?.outcome === "string" ? payload.outcome : undefined,
  };
};

/** Pure state machine for the thread's reconnecting notice. */
export function deriveThreadRecoveryNotice(input: {
  readonly request: ThreadTurnStartRequest | null | undefined;
  readonly activities: ReadonlyArray<RecoveryActivity>;
  readonly nowMs: number;
}): ThreadRecoveryNoticeDerivation {
  const { request } = input;
  if (!request) return { notice: null, nextChangeInMs: null };
  const requestedAtMs = Date.parse(request.requestedAt);
  const steps = input.activities
    .filter(
      (activity) =>
        activity.kind === PROVIDER_SESSION_RECOVERY_ACTIVITY_KIND &&
        Date.parse(activity.createdAt) >= requestedAtMs,
    )
    .map(recoveryStep);
  const settledAtMs = request.settledAt === null ? input.nowMs : Date.parse(request.settledAt);
  const waitedMs = settledAtMs - requestedAtMs;
  const slow = steps.length > 0 || waitedMs >= RECONNECTING_NOTICE_DELAY_MS;

  if (request.outcome === "pending") {
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
  if (request.outcome === "failed") {
    const latestFailure = input.activities.findLast(
      (activity) =>
        activity.kind === TURN_START_FAILED_ACTIVITY_KIND &&
        Date.parse(activity.createdAt) >= requestedAtMs,
    );
    const failureClass = failureClassOf(latestFailure) ?? "";
    const forkOnly = FORK_ONLY_FAILURE_CLASSES.has(failureClass);
    if (!slow && !forkOnly) return { notice: null, nextChangeInMs: null };
    return {
      notice: notice(
        "failed",
        failureClass === "provider-unavailable"
          ? "The provider is not available (not installed, not executable, or disabled). Fix it in Settings, or continue in a new thread."
          : forkOnly
            ? "This thread's provider session cannot be resumed. Continue in a new thread to keep working."
            : "The turn did not start. See the error above for details.",
      ),
      nextChangeInMs: null,
    };
  }
  if (!slow) return { notice: null, nextChangeInMs: null };
  const remainingMs = settledAtMs + RECOVERED_NOTICE_VISIBLE_MS - input.nowMs;
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
