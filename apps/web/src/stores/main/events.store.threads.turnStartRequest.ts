import type { MessageId } from "@bigbud/contracts";

import type { ThreadTurnStartRequest } from "../../models/types/app.types";

const PROVIDER_SESSION_RECOVERY_ACTIVITY_KIND = "provider.session.recovery";

/** Tracks a `thread.turn-start-requested` until the server starts or fails that turn. */
export function requestTurnStart(
  messageId: MessageId,
  requestedAt: string,
): ThreadTurnStartRequest {
  return { messageId, requestedAt, outcome: "pending", settledAt: null, recoverySteps: [] };
}

/** Settles a pending request; settled or absent requests are returned unchanged. */
export function settleTurnStartRequest(
  request: ThreadTurnStartRequest | null | undefined,
  outcome: "started" | "failed",
  settledAt: string,
): ThreadTurnStartRequest | null | undefined {
  return request?.outcome === "pending" ? { ...request, outcome, settledAt } : request;
}

/**
 * Drops a pending request that will not start a turn by itself (stopped, interrupted, or turned
 * into a queued prompt). With a message id, only that message's request is dropped.
 */
export function clearPendingTurnStartRequest(
  request: ThreadTurnStartRequest | null | undefined,
  messageId?: MessageId,
): ThreadTurnStartRequest | null | undefined {
  if (request?.outcome !== "pending") return request;
  return messageId === undefined || request.messageId === messageId ? null : request;
}

/**
 * Attaches a server recovery step to the current request. The reactor reports steps only while it
 * handles that request, so arrival order identifies them; a step may still arrive after the turn
 * started, so settled requests keep collecting until the next request replaces them.
 */
export function recordTurnStartRecoveryStep(
  request: ThreadTurnStartRequest | null | undefined,
  activity: { readonly kind: string; readonly payload: unknown },
): ThreadTurnStartRequest | null | undefined {
  if (!request || activity.kind !== PROVIDER_SESSION_RECOVERY_ACTIVITY_KIND) return request;
  const payload = activity.payload as { step?: unknown; outcome?: unknown } | null;
  if (typeof payload?.step !== "string" || typeof payload.outcome !== "string") return request;
  return {
    ...request,
    recoverySteps: [...request.recoverySteps, { step: payload.step, outcome: payload.outcome }],
  };
}
