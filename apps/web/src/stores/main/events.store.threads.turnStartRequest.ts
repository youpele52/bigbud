import type { MessageId } from "@bigbud/contracts";

import type { ThreadTurnStartRequest } from "../../models/types/app.types";

/** Tracks a `thread.turn-start-requested` until the server starts or fails that turn. */
export function requestTurnStart(
  messageId: MessageId,
  requestedAt: string,
): ThreadTurnStartRequest {
  return { messageId, requestedAt, outcome: "pending", settledAt: null };
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
