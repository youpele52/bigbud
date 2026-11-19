/**
 * Worker-side wait detail for a `waiting` peer child: why it is blocked and, for an approval,
 * which kind. Only bounded kinds cross the peer boundary, never the command, path or question.
 *
 * @module peerWorker.waiting
 */
import type { OrchestrationThread, OrchestrationThreadActivity } from "@bigbud/contracts";
import { ProviderRequestKind } from "@bigbud/contracts/orchestration/orchestration.provider.ts";
import type { PeerChildWaiting } from "@bigbud/contracts/server/remotePeer.wire.ts";
import { Schema } from "effect";

const isRequestKind = Schema.is(ProviderRequestKind);

/** Activity order: provider sequence first, then creation time and id (as the workflow status). */
function byOrder(left: OrchestrationThreadActivity, right: OrchestrationThreadActivity): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  } else if (left.sequence !== undefined) return 1;
  else if (right.sequence !== undefined) return -1;
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

const RESOLVED_APPROVAL = new Set(["approval.resolved", "provider.approval.respond.failed"]);

/** The request kind of the most recent approval that is still open, when it names one. */
export function latestOpenApprovalKind(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ProviderRequestKind | undefined {
  const open = new Map<string, ProviderRequestKind | undefined>();
  for (const activity of activities.toSorted(byOrder)) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (activity.kind === "approval.requested") {
      open.delete(requestId);
      open.set(requestId, isRequestKind(payload?.requestKind) ? payload.requestKind : undefined);
    } else if (RESOLVED_APPROVAL.has(activity.kind)) open.delete(requestId);
  }
  return [...open.values()].at(-1);
}

/** The wait detail of a child whose workflow status shows a pending approval or user input. */
export function peerChildWaiting(
  thread: OrchestrationThread,
  pending: { readonly hasPendingApprovals: boolean; readonly hasPendingUserInput: boolean },
): PeerChildWaiting | undefined {
  if (pending.hasPendingApprovals) {
    const approvalKind = latestOpenApprovalKind(thread.activities);
    return approvalKind
      ? { reason: "approval-pending", approvalKind }
      : { reason: "approval-pending" };
  }
  return pending.hasPendingUserInput ? { reason: "user-input-pending" } : undefined;
}
